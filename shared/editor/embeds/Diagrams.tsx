import { EditIcon } from "outline-icons";
import * as React from "react";
import styled from "styled-components";
import Frame from "../components/Frame";
import Image from "../components/Img";
import { EmbedProps as Props } from ".";

/**
 * 씽크풀 drawio 임베드 컴포넌트.
 *
 * 편집 가능 상태(isEditable) + drawio.thinkpool-insight.com 도메인일 때,
 * 우상단에 "편집" 및 "이름 바꾸기" 오버레이가 뜬다.
 *
 * 편집: window.__thinkpoolDrawioEdit(href) → 새 탭에서 drawio 편집기 오픈
 *       저장 완료 시 shared → app 방향으로 CustomEvent가 발동되며 embed 노드 href 교체
 *
 * 이름 바꾸기: window.__thinkpoolDrawioRename(href, newTitle) → URL 쿼리 갱신
 *              그 결과를 CustomEvent로 dispatch해서 노드 갱신
 */

function Diagrams({ matches, ...props }: Props) {
  const { embed, isEditable, attrs } = props;
  const embedUrl = matches[0];
  const params = new URL(embedUrl).searchParams;
  const isThinkpoolDrawio = embedUrl.startsWith(
    "https://drawio.thinkpool-insight.com/"
  );
  const titlePrefix = embed.settings?.url ? "Draw.io" : "Diagrams.net";
  const displayTitle = params.get("diag") || params.get("title");
  const title = displayTitle ? `${titlePrefix} (${displayTitle})` : titlePrefix;

  // 씽크풀 drawio URL이면 항상 오버레이 표시 (share/view 모드에서도 편집 링크로 사용).
  // isEditable false일 때 저장은 되지만 위키 자동 갱신은 불가 → openEdit 안에서 안내.
  const showThinkpoolControls = isThinkpoolDrawio;

  const openEdit = React.useCallback(() => {
    const w = window as unknown as {
      __thinkpoolDrawioEdit?: (href: string) => Window | null;
    };
    if (typeof w.__thinkpoolDrawioEdit !== "function") {
      // eslint-disable-next-line no-console
      console.warn("__thinkpoolDrawioEdit not installed");
      return;
    }
    if (!isEditable) {
      // eslint-disable-next-line no-alert
      const proceed = window.confirm(
        "이 페이지는 읽기 전용입니다. 편집기는 열리지만 저장해도 위키 페이지의 다이어그램은 자동 갱신되지 않습니다. 계속 진행하시겠습니까?"
      );
      if (!proceed) {
        return;
      }
    }
    const opened = w.__thinkpoolDrawioEdit(attrs.href);
    if (!opened) {
      // eslint-disable-next-line no-alert
      window.alert(
        "팝업이 차단되었습니다. 브라우저에서 이 사이트의 팝업 허용 후 다시 시도해주세요."
      );
    }
  }, [attrs.href, isEditable]);

  const rename = React.useCallback(() => {
    if (!isEditable) {
      // eslint-disable-next-line no-alert
      window.alert("제목 변경은 편집 모드에서만 가능합니다.");
      return;
    }
    const w = window as unknown as {
      __thinkpoolDrawioRename?: (href: string, title: string) => string;
      __thinkpoolDrawioGetTitle?: (href: string) => string;
      __thinkpoolDrawioUpdatedEvent?: string;
    };
    if (
      typeof w.__thinkpoolDrawioRename !== "function" ||
      typeof w.__thinkpoolDrawioGetTitle !== "function" ||
      !w.__thinkpoolDrawioUpdatedEvent
    ) {
      return;
    }
    const current = w.__thinkpoolDrawioGetTitle(attrs.href);
    // eslint-disable-next-line no-alert
    const next = window.prompt("다이어그램 제목", current);
    if (next === null) {
      return;
    }
    const newHref = w.__thinkpoolDrawioRename(attrs.href, next);
    if (newHref === attrs.href) {
      return;
    }
    window.dispatchEvent(
      new CustomEvent(w.__thinkpoolDrawioUpdatedEvent, {
        detail: { oldHref: attrs.href, newHref },
      })
    );
  }, [attrs.href, isEditable]);

  return (
    <Wrapper>
      <Frame
        {...props}
        src={props.attrs.href}
        icon={
          <Image
            src="/images/diagrams.png"
            alt="Diagrams.net"
            width={16}
            height={16}
          />
        }
        canonicalUrl={props.attrs.href}
        title={title}
        border
      />
      {showThinkpoolControls && (
        <ControlBar>
          <ControlButton onClick={rename} title="다이어그램 이름 변경">
            ✎ 이름
          </ControlButton>
          <ControlButton
            onClick={openEdit}
            title="새 탭에서 draw.io 편집기 열기"
          >
            <EditIcon size={14} /> 편집
          </ControlButton>
        </ControlBar>
      )}
    </Wrapper>
  );
}

const Wrapper = styled.div`
  position: relative;
`;

const ControlBar = styled.div`
  position: absolute;
  top: 6px;
  right: 6px;
  display: flex;
  gap: 4px;
  z-index: 2;
`;

const ControlButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  font-size: 12px;
  color: #fff;
  background: rgba(0, 0, 0, 0.55);
  border: 0;
  border-radius: 4px;
  cursor: pointer;

  &:hover {
    background: rgba(0, 0, 0, 0.72);
  }
`;

export default Diagrams;
