/**
 * 새 탭 기반 draw.io 세션 매니저 + 재편집 브리지.
 *
 * 새 다이어그램:
 *   openDrawioEditor({ documentId, onSaved })
 *
 * 재편집 (기존 임베드 클릭):
 *   window.__thinkpoolDrawioEdit(oldHref) → 새 탭 오픈 + 저장 시 CustomEvent 발생
 *   → Editor.tsx가 리스너로 embed 노드의 href를 갱신
 *
 * 첨부 in-place 갱신:
 *   embed URL의 ?aid=<uuid> 쿼리 파라미터로 이전 첨부 ID 추적 → 저장 시 삭제
 *
 * 다이어그램 제목 변경:
 *   ?diag=<title> 쿼리로 사용자 지정 제목 저장 → 첨부 파일명에 반영
 */
import pako from "pako";
import { AttachmentPreset } from "@shared/types";
import { client } from "./ApiClient";
import { uploadFile } from "./files";

const DRAWIO_BASE = "https://drawio.thinkpool-insight.com/";
const DRAWIO_ORIGIN = "https://drawio.thinkpool-insight.com";
const DRAWIO_UPDATED_EVENT = "thinkpool-drawio-updated";

const EMBED_PARAMS = new URLSearchParams({
  embed: "1",
  ui: "atlas",
  spin: "1",
  modified: "unsavedChanges",
  proto: "json",
  saveAndExit: "1",
  keepmodified: "1",
}).toString();

type OpenOptions = {
  initialXml?: string;
  documentId?: string;
  /** 재편집일 때 이전 URL을 전달하면 aid 추출해서 old attachment 삭제 + href 매칭용 dispatch 발생 */
  oldHref?: string;
  onSaved: (embedUrl: string, attachmentUrl: string) => void;
  onClosed?: () => void;
};

type Session = OpenOptions & {
  initialized: boolean;
};

const sessions = new Map<Window, Session>();
let listenerAttached = false;
const closedWatchers = new Map<Window, ReturnType<typeof setInterval>>();

function ensureListener(): void {
  if (listenerAttached) {
    return;
  }
  window.addEventListener("message", handleMessage);
  listenerAttached = true;
}

function handleMessage(event: MessageEvent): void {
  if (event.origin !== DRAWIO_ORIGIN) {
    return;
  }
  if (typeof event.data !== "string") {
    return;
  }
  const src = event.source as Window | null;
  if (!src) {
    return;
  }
  const session = sessions.get(src);
  if (!session) {
    return;
  }

  let payload: { event?: string; xml?: string };
  try {
    payload = JSON.parse(event.data);
  } catch {
    return;
  }

  switch (payload.event) {
    case "init":
      if (!session.initialized) {
        session.initialized = true;
        src.postMessage(
          JSON.stringify({
            action: "load",
            xml: session.initialXml || DEFAULT_EMPTY_DIAGRAM,
            autosave: 0,
          }),
          DRAWIO_ORIGIN
        );
      }
      break;
    case "save":
      if (payload.xml) {
        void handleSave(session, payload.xml, src);
      }
      break;
    case "exit":
      cleanup(src, session);
      break;
    default:
      break;
  }
}

async function handleSave(
  session: Session,
  xml: string,
  src: Window
): Promise<void> {
  const inferredTitle = extractDiagramTitle(xml) || "diagram";
  // 이전 URL에서 사용자 지정 제목을 우선 승계
  const previousTitle = session.oldHref
    ? extractQueryParam(session.oldHref, "diag")
    : null;
  const title = previousTitle || inferredTitle;
  const filename = `${sanitizeFilename(title)}.drawio`;

  let attachmentUrl = "";
  let attachmentId = "";
  try {
    const blob = new Blob([xml], { type: "application/xml" });
    const file = new File([blob], filename, { type: "application/xml" });
    const attachment = await uploadFile(file, {
      preset: AttachmentPreset.DocumentAttachment,
      documentId: session.documentId,
      name: filename,
    });
    attachmentUrl = (attachment as { url?: string })?.url || "";
    attachmentId = (attachment as { id?: string })?.id || "";
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("drawio attachment upload failed", e);
  }

  // 재편집이면 이전 attachment 삭제 (in-place 갱신 효과)
  if (session.oldHref) {
    const oldAid = extractQueryParam(session.oldHref, "aid");
    if (oldAid && oldAid !== attachmentId) {
      try {
        await client.post("/attachments.delete", { id: oldAid });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("drawio old attachment delete failed", e);
      }
    }
  }

  const embedUrl = xmlToEmbedUrl(xml, title, attachmentId);
  session.onSaved(embedUrl, attachmentUrl);

  // 재편집일 때 shared 컴포넌트에서 걸어둔 리스너에게 알림
  if (session.oldHref) {
    window.dispatchEvent(
      new CustomEvent(DRAWIO_UPDATED_EVENT, {
        detail: { oldHref: session.oldHref, newHref: embedUrl },
      })
    );
  }

  cleanup(src, session);
}

function cleanup(src: Window, session: Session): void {
  if (sessions.has(src)) {
    sessions.delete(src);
  }
  const watcher = closedWatchers.get(src);
  if (watcher) {
    clearInterval(watcher);
    closedWatchers.delete(src);
  }
  session.onClosed?.();
  try {
    if (!src.closed) {
      src.close();
    }
  } catch {
    // ignore
  }
}

export function openDrawioEditor(opts: OpenOptions): Window | null {
  ensureListener();
  const features =
    "popup=yes,width=1600,height=1000,resizable=yes,scrollbars=yes";
  const w = window.open(`${DRAWIO_BASE}?${EMBED_PARAMS}`, "_blank", features);
  if (!w) {
    return null;
  }
  sessions.set(w, {
    initialXml: opts.initialXml || "",
    documentId: opts.documentId,
    oldHref: opts.oldHref,
    onSaved: opts.onSaved,
    onClosed: opts.onClosed,
    initialized: false,
  });
  const watcher = setInterval(() => {
    if (w.closed) {
      const s = sessions.get(w);
      if (s) {
        sessions.delete(w);
        clearInterval(watcher);
        closedWatchers.delete(w);
        s.onClosed?.();
      }
    }
  }, 1000);
  closedWatchers.set(w, watcher);
  return w;
}

/**
 * 기존 draw.io 임베드 URL로부터 XML을 복원하여 재편집 세션을 시작.
 * 저장 시 window.dispatchEvent(CustomEvent<"thinkpool-drawio-updated">) 로
 * {oldHref, newHref}를 알린다.
 *
 * 이 함수는 shared 코드가 접근할 수 있도록 mount 시점에 window에 노출된다.
 */
export function openDrawioEditorForEdit(oldHref: string): Window | null {
  const xml = decompressXmlFromEmbedUrl(oldHref);
  if (!xml) {
    // eslint-disable-next-line no-console
    console.warn("cannot decompress XML from embed URL", oldHref);
    return null;
  }
  return openDrawioEditor({
    initialXml: xml,
    oldHref,
    // onSaved에서 뭘 할지는 재편집 케이스에선 dispatchEvent가 다 처리 → no-op
    onSaved: () => undefined,
  });
}

/** 다이어그램 제목을 사용자 정의로 rename. 첨부 파일명은 다음 저장 때 반영. */
export function renameDrawioEmbed(oldHref: string, newTitle: string): string {
  const url = new URL(oldHref);
  const trimmed = newTitle.trim().slice(0, 60);
  if (trimmed) {
    url.searchParams.set("diag", trimmed);
    url.searchParams.set("title", trimmed);
  } else {
    url.searchParams.delete("diag");
  }
  return url.toString();
}

/** 임베드 URL에 저장된 사용자 지정 제목 (?diag) 우선, 없으면 ?title */
export function getDrawioEmbedTitle(href: string): string {
  return (
    extractQueryParam(href, "diag") ||
    extractQueryParam(href, "title") ||
    "diagram"
  );
}

/** 이 함수는 App 마운트 시 한 번 호출해서 shared 코드에서 재편집 가능하게 함 */
export function installDrawioGlobalBridge(): void {
  const w = window as unknown as {
    __thinkpoolDrawioEdit?: (href: string) => Window | null;
    __thinkpoolDrawioRename?: (href: string, title: string) => string;
    __thinkpoolDrawioGetTitle?: (href: string) => string;
    __thinkpoolDrawioUpdatedEvent?: string;
  };
  w.__thinkpoolDrawioEdit = openDrawioEditorForEdit;
  w.__thinkpoolDrawioRename = renameDrawioEmbed;
  w.__thinkpoolDrawioGetTitle = getDrawioEmbedTitle;
  w.__thinkpoolDrawioUpdatedEvent = DRAWIO_UPDATED_EVENT;
}

export const DRAWIO_UPDATED_EVENT_NAME = DRAWIO_UPDATED_EVENT;

/** XML → drawio 뷰어용 lightbox URL (compressed fragment + aid/diag params) */
function xmlToEmbedUrl(
  xml: string,
  title: string,
  attachmentId?: string
): string {
  const compressed = pako.deflateRaw(new TextEncoder().encode(xml));
  const b64 = btoa(String.fromCharCode(...compressed));
  const params = new URLSearchParams({
    lightbox: "1",
    highlight: "0000ff",
    nav: "1",
    title,
    diag: title,
  });
  if (attachmentId) {
    params.set("aid", attachmentId);
  }
  return `${DRAWIO_BASE}?${params.toString()}#R${encodeURIComponent(b64)}`;
}

/** embed URL의 fragment(#R<base64 of raw deflate>)에서 XML 복원. 실패 시 null */
function decompressXmlFromEmbedUrl(href: string): string | null {
  try {
    const url = new URL(href);
    const hash = url.hash || "";
    if (!hash.startsWith("#R")) {
      return null;
    }
    const b64 = decodeURIComponent(hash.slice(2));
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const inflated = pako.inflateRaw(bytes);
    return new TextDecoder().decode(inflated);
  } catch {
    return null;
  }
}

function extractQueryParam(href: string, name: string): string | null {
  try {
    const url = new URL(href);
    return url.searchParams.get(name);
  } catch {
    return null;
  }
}

const DEFAULT_EMPTY_DIAGRAM =
  '<mxfile host="drawio.thinkpool-insight.com" agent="outline"><diagram name="Page-1"><mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';

function extractDiagramTitle(xml: string): string | null {
  const m = xml.match(/<diagram[^>]*name="([^"]+)"/);
  return m ? m[1] : null;
}

function sanitizeFilename(name: string): string {
  return (
    name
      .replace(/[^A-Za-z0-9가-힣_-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "diagram"
  );
}
