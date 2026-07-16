/**
 * 새 탭 기반 draw.io 세션 매니저.
 *
 * 흐름:
 * 1. openDrawioEditor(opts)를 호출하면 window.open() 으로 drawio 편집기 탭을 띄움
 * 2. 모듈 레벨에서 한 번만 등록된 전역 message 리스너가 postMessage를 받음
 * 3. event.source(=탭의 window)로 세션 매칭 → drawio의 init/save/exit 이벤트 처리
 * 4. save: XML을 첨부파일로 업로드 + 압축 URL 생성 → onSaved 콜백으로 부모에 전달
 * 5. exit 또는 탭 닫힘: 세션 정리 + onClosed 콜백
 *
 * 왜 새 탭:
 *  - drawio는 원래 풀 웹앱. iframe 안에 넣으면 UI가 눌리고 단축키가 어색함
 *  - Google Docs / Notion / Confluence의 drawio 통합도 새 탭/팝업 방식
 *  - 여러 위키 문서를 열어놓고 참고하며 편집 가능
 */
import pako from "pako";
import { AttachmentPreset } from "@shared/types";
import { uploadFile } from "./files";

const DRAWIO_BASE = "https://drawio.thinkpool-insight.com/";
const DRAWIO_ORIGIN = "https://drawio.thinkpool-insight.com";

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
  /** 편집 대상 XML. undefined면 빈 다이어그램으로 시작 */
  initialXml?: string;
  /** 첨부파일이 붙을 문서 ID */
  documentId?: string;
  /** 사용자가 drawio에서 저장했을 때. embedUrl = 위키에 삽입할 URL */
  onSaved: (embedUrl: string, attachmentUrl: string) => void;
  /** 탭이 저장 없이 닫혔거나, 저장 이후 정리될 때 */
  onClosed?: () => void;
};

type Session = OpenOptions & {
  /** drawio가 처음 init을 보냈을 때만 load를 발송 (중복 방지) */
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
  const title = extractDiagramTitle(xml) || "diagram";
  const filename = `${sanitizeFilename(title)}.drawio`;

  let attachmentUrl = "";
  try {
    const blob = new Blob([xml], { type: "application/xml" });
    const file = new File([blob], filename, { type: "application/xml" });
    const attachment = await uploadFile(file, {
      preset: AttachmentPreset.DocumentAttachment,
      documentId: session.documentId,
      name: filename,
    });
    attachmentUrl = (attachment as { url?: string })?.url || "";
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("drawio attachment upload failed", e);
  }

  const embedUrl = xmlToEmbedUrl(xml, title);
  session.onSaved(embedUrl, attachmentUrl);
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
    // src.close()는 window.open()으로 연 창만 가능. 실패해도 무시.
  }
}

/**
 * drawio 편집기를 새 탭으로 열고, 세션을 등록한다.
 * @returns 열린 Window (팝업 차단 시 null)
 */
export function openDrawioEditor(opts: OpenOptions): Window | null {
  ensureListener();
  // 새 탭 열기. features 스트링을 주면 팝업 스타일로 뜸.
  // 사용자 클릭 이벤트 콜스택 안에서 호출되어야 팝업 블로커 통과.
  const features =
    "popup=yes,width=1600,height=1000,resizable=yes,scrollbars=yes";
  const w = window.open(`${DRAWIO_BASE}?${EMBED_PARAMS}`, "_blank", features);
  if (!w) {
    return null;
  }
  sessions.set(w, {
    initialXml: opts.initialXml || "",
    documentId: opts.documentId,
    onSaved: opts.onSaved,
    onClosed: opts.onClosed,
    initialized: false,
  });
  // 사용자가 저장 없이 탭을 그냥 닫아도 정리
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

/** XML → drawio 뷰어용 lightbox URL (compressed fragment) */
function xmlToEmbedUrl(xml: string, title: string): string {
  const compressed = pako.deflateRaw(new TextEncoder().encode(xml));
  const b64 = btoa(String.fromCharCode(...compressed));
  const params = new URLSearchParams({
    lightbox: "1",
    highlight: "0000ff",
    nav: "1",
    title,
  });
  return `${DRAWIO_BASE}?${params.toString()}#R${encodeURIComponent(b64)}`;
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
