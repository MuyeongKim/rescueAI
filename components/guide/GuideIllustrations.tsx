import { ArrowDown, ArrowRight, BookOpen, Check, FileText, MessageSquare, Presentation } from "lucide-react";

import { USER_GUIDE_QUESTION_EXAMPLE } from "@/lib/user-guide-content";
import styles from "./user-guide.module.css";

/** 실제 답변·자료로 오해하지 않도록 모든 그림에 예시 표시를 붙입니다. */
export function QuestionIllustration() {
  return (
    <figure className={styles.example} aria-label="질문과 출처를 확인하는 화면 예시">
      <figcaption className={styles.exampleHeading}><MessageSquare aria-hidden="true" size={20} /> AI 튜터 · 화면 예시</figcaption>
      <div className={styles.chatExample}>
        <p className={styles.questionBubble}>{USER_GUIDE_QUESTION_EXAMPLE}</p>
        <div className={styles.answerBubble}>
          <p className={styles.exampleLabel}>답변이 표시되는 자리</p>
          <p>이곳에서 답변을 읽습니다. 아래 출처에서 어떤 자료를 참고했는지 확인하세요.</p>
          <div className={styles.exampleSource}><BookOpen aria-hidden="true" size={18} /><span>자료 제목 · 페이지 번호</span></div>
        </div>
      </div>
      <p className={styles.exampleCaption}>사용 방법을 설명하는 그림입니다. 실제 AI 답변이나 매뉴얼 내용이 아닙니다.</p>
    </figure>
  );
}

export function CreationIllustration() {
  return (
    <figure className={styles.example} aria-label="자료를 만드는 순서 예시">
      <figcaption className={styles.exampleHeading}><FileText aria-hidden="true" size={20} /> AI 자료제작 · 입력 예시</figcaption>
      <dl className={styles.sampleForm}>
        <div><dt>만들 자료</dt><dd>슬라이드</dd></div>
        <div><dt>자료 주제</dt><dd>공기호흡기 착용 전 점검</dd></div>
        <div><dt>대상 · 교육 시간</dt><dd>신규 대원 · 30분</dd></div>
      </dl>
      <div className={styles.creationFlow}>
        <span><FileText aria-hidden="true" size={19} /> 입력</span>
        <ArrowRight className={styles.flowArrow} aria-hidden="true" size={20} />
        <span><Check aria-hidden="true" size={19} /> 구성 확인</span>
        <ArrowRight className={styles.flowArrow} aria-hidden="true" size={20} />
        <span><Presentation aria-hidden="true" size={19} /> 제작</span>
      </div>
      <p className={styles.exampleCaption}>이 그림에서는 입력하지 않습니다. ‘AI 자료제작’ 메뉴에서 시작하세요.</p>
    </figure>
  );
}

export function SourceIllustration() {
  return (
    <figure className={styles.sourceExample} aria-label="원문 확대 후에도 전체 페이지와 출처를 함께 확인하는 예시">
      <figcaption className={styles.exampleHeading}><Presentation aria-hidden="true" size={20} /> 원문 확대 · 표시 예시</figcaption>
      <div className={styles.sourceFlow}>
        <div>
          <div className={styles.paperExample} aria-hidden="true">
            <div className={styles.paperFocus}><span /><span /><span /></div>
            <div className={styles.paperLines}><span /><span /><span /><span /></div>
          </div>
          <p>전체 페이지</p>
        </div>
        <ArrowRight className={styles.sourceArrow} aria-hidden="true" size={24} />
        <ArrowDown className={styles.sourceArrowMobile} aria-hidden="true" size={24} />
        <div className={styles.zoomExample}>
          <div className={styles.zoomLines} aria-hidden="true"><span /><span /><span /></div>
          <p>필요한 부분을 크게</p>
          <span className={styles.sourceRetained}>전체 원문 + 출처도 함께</span>
        </div>
      </div>
      <p className={styles.exampleCaption}>원문을 확대하는 방법을 설명하는 그림입니다. 확대 전후의 내용을 함께 확인하세요.</p>
    </figure>
  );
}
