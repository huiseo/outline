import pako from "pako";
import * as React from "react";
import styled from "styled-components";
import { AttachmentPreset } from "@shared/types";
import { uploadFile } from "~/utils/files";

/**
 * Confluence-style drawio 편집기 모달.
 *
 * 흐름:
 * 1. 부모는 initialXml (편집 모드) 또는 undefined (신규)를 넘김
 * 2. 내부 iframe이 우리 self-hosted drawio를 embed 모드로 로드
 * 3. drawio가 `init` postMessage를 보내면 `load` 액션으로 XML을 실어보냄
 * 4. 사용자가 저장하면 drawio가 `save`/`autosave` postMessage로 XML을 반환
 * 5. XML을 (a) 현재 문서에 attachment로 업로드, (b) 압축해서 embed URL fragment로 인코딩
 * 6. onSaved(embedUrl, attachmentUrl) 호출 → 부모가 embed 노드를 문서에 삽입
 */
type Props = {
  initialXml?: string;
  documentId?: string;
  onSaved: (embedUrl: string, attachmentUrl: string) => void;
  onClose: () => void;
};

const DRAWIO_BASE = "https://drawio.thinkpool-insight.com/";

const embedSrc = () =>
  `${DRAWIO_BASE}?embed=1&ui=atlas&spin=1&modified=unsavedChanges&proto=json&saveAndExit=1&noSaveBtn=0&noExitBtn=0&keepmodified=1`;

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

const IframeWrap = styled.div`
  position: relative;
  width: 100%;
  height: 75vh;
  min-height: 500px;
  background: #f7f7f7;
`;

const Iframe = styled.iframe`
  width: 100%;
  height: 100%;
  border: 0;
`;

const HelpBar = styled.div`
  padding: 6px 12px;
  font-size: 12px;
  color: ${(p) => p.theme.textSecondary};
  border-top: 1px solid ${(p) => p.theme.divider};
`;

const DrawioModal: React.FC<Props> = ({
  initialXml,
  documentId,
  onSaved,
  onClose,
}) => {
  const iframeRef = React.useRef<HTMLIFrameElement>(null);

  const post = React.useCallback((msg: object) => {
    iframeRef.current?.contentWindow?.postMessage(JSON.stringify(msg), "*");
  }, []);

  const handleSaved = React.useCallback(
    async (xml: string) => {
      const title = extractDiagramTitle(xml) || "diagram";
      const filename = `${sanitizeFilename(title)}.drawio`;

      let attachmentUrl = "";
      try {
        const blob = new Blob([xml], { type: "application/xml" });
        const file = new File([blob], filename, { type: "application/xml" });
        const attachment = await uploadFile(file, {
          preset: AttachmentPreset.DocumentAttachment,
          documentId,
          name: filename,
        });
        attachmentUrl = attachment?.url || "";
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("drawio attachment upload failed", e);
      }

      const embedUrl = xmlToEmbedUrl(xml, title);
      onSaved(embedUrl, attachmentUrl);
    },
    [documentId, onSaved]
  );

  React.useEffect(() => {
    const handler = (event: MessageEvent) => {
      try {
        const originUrl = new URL(event.origin);
        if (originUrl.hostname !== "drawio.thinkpool-insight.com") {
          return;
        }
      } catch {
        return;
      }
      if (typeof event.data !== "string") {
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
          post({
            action: "load",
            xml: initialXml || DEFAULT_EMPTY_DIAGRAM,
            autosave: 0,
          });
          break;
        case "save":
          if (payload.xml) {
            void handleSaved(payload.xml);
          }
          break;
        case "exit":
          onClose();
          break;
        default:
          break;
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [initialXml, onClose, post, handleSaved]);

  return (
    <div>
      <IframeWrap>
        <Iframe
          ref={iframeRef}
          src={embedSrc()}
          allow="clipboard-read; clipboard-write"
          title="draw.io 편집기"
        />
      </IframeWrap>
      <HelpBar>
        저장하면 <strong>.drawio</strong> 파일이 현재 문서에 첨부되고, 편집기가
        닫히면서 페이지에 자동 임베드됩니다.
      </HelpBar>
    </div>
  );
};

const DEFAULT_EMPTY_DIAGRAM = `<mxfile host="drawio.thinkpool-insight.com" agent="outline"><diagram name="Page-1"><mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>`;

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

export default DrawioModal;
