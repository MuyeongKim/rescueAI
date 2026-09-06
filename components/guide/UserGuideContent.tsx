import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, BookOpen, ChevronDown, FileText, MessageSquare, ShieldCheck, Wand2 } from "lucide-react";

import {
  USER_GUIDE_CREATE_STEPS,
  USER_GUIDE_HELP,
  USER_GUIDE_QUESTION_PARTS,
  USER_GUIDE_QUICK_STEPS,
  USER_GUIDE_SECTIONS,
  USER_GUIDE_STORAGE_ITEMS,
  type UserGuideSectionId,
} from "@/lib/user-guide-content";
import { CreationIllustration, QuestionIllustration, SourceIllustration } from "./GuideIllustrations";
import styles from "./user-guide.module.css";

const quickIcons = [MessageSquare, Wand2, BookOpen];

function GuideSection({ id, children }: { id: UserGuideSectionId; children: ReactNode }) {
  const section = USER_GUIDE_SECTIONS.find((item) => item.id === id)!;
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className={styles.section}>
      <header className={styles.sectionHeading}>
        <h2 id={`${id}-heading`}>{section.title}</h2>
        <p>{section.description}</p>
      </header>
      {children}
    </section>
  );
}

export function UserGuideContent({ actions }: { actions?: ReactNode }) {
  return (
    <article className={styles.guide}>
      <header className={styles.hero}>
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}><BookOpen aria-hidden="true" size={19} /> 구조 AI 사용설명서</p>
          <h1>처음 써도,<br /><span>하나씩 따라오세요.</span></h1>
          <p className={styles.lead}>궁금한 내용을 찾고, 훈련자료를 만들고,<br className={styles.desktopBreak} /> 원본까지 확인하는 방법을 알려드립니다.</p>
          <p className={styles.readingTime}>전체 읽기 약 5분 · 필요한 부분만 골라 읽어도 됩니다.</p>
        </div>
        <div className={styles.heroNote}>
          <ShieldCheck aria-hidden="true" size={26} />
          <p><strong>답변과 자료는 확인하며 사용하세요.</strong><span>이 플랫폼은 교육 준비를 돕습니다. 장비별 수치와 적용 조건은 원본과 함께 확인하세요. 실제 현장에서는 현장 지휘와 소속 기관의 지침을 따르세요.</span></p>
        </div>
      </header>

      {actions && <div className={styles.actions}>{actions}</div>}

      <nav aria-label="사용설명서 목차" className={styles.contents}>
        <p>어떤 도움이 필요한가요?</p>
        <div>{USER_GUIDE_SECTIONS.map((section) => <a key={section.id} href={`#${section.id}`}>{section.shortTitle}<ArrowRight aria-hidden="true" size={16} /></a>)}</div>
      </nav>

      <GuideSection id="start">
        <div className={styles.quickGrid}>
          {USER_GUIDE_QUICK_STEPS.map((item, index) => {
            const Icon = quickIcons[index];
            return <div key={item.href} className={styles.quickItem}>
              <Icon aria-hidden="true" size={25} />
              <h3>{item.title}</h3>
              <p>{item.description}</p>
              <Link href={item.href} className={styles.textLink}>{item.label}<ArrowRight aria-hidden="true" size={18} /></Link>
            </div>;
          })}
        </div>
        <p className={styles.tip}>컴퓨터에서는 왼쪽 메뉴, 휴대전화에서는 화면 아래 메뉴를 이용하세요. 휴대전화의 다른 메뉴는 <strong>더보기</strong>에서 찾을 수 있습니다.</p>
      </GuideSection>

      <GuideSection id="ask">
        <ol className={styles.stepList}>
          <li><strong>분야는 ‘자동’으로 시작하세요.</strong><p>찾을 분야가 분명할 때만 직접 바꾸세요.</p></li>
          <li><strong>상황과 원하는 설명을 함께 적으세요.</strong><p>‘안전하게 쓰는 법’보다는 어떤 장비인지, 누구를 위한 설명인지 알려주는 것이 좋습니다.</p></li>
          <li><strong>답변을 읽고 출처를 확인하세요.</strong><p>답변 아래의 출처에서 자료 제목과 페이지를 확인하세요. 필요하면 원본을 열어 앞뒤 내용도 읽어보세요.</p></li>
        </ol>
        <QuestionIllustration />
        <dl className={styles.questionParts}>{USER_GUIDE_QUESTION_PARTS.map((part) => <div key={part.title}><dt>{part.title}</dt><dd>{part.text}</dd></div>)}</dl>
        <p className={styles.tip}>같은 주제는 이어서 질문하세요. 예: <strong>“방금 설명한 내용을 점검표로 정리해줘.”</strong> 다른 주제라면 새 대화를 시작하면 됩니다.</p>
        <div className={styles.helpList}>{USER_GUIDE_HELP.slice(0, 2).map((item) => <details key={item.question} className={styles.help}><summary>{item.question}<ChevronDown aria-hidden="true" size={20} /></summary><p>{item.answer}</p></details>)}</div>
      </GuideSection>

      <GuideSection id="create">
        <div className={styles.createGrid}>
          <ol className={styles.stepList}>{USER_GUIDE_CREATE_STEPS.map((step) => <li key={step.title}><strong>{step.title}</strong><p>{step.text}</p></li>)}</ol>
          <CreationIllustration />
        </div>
        <p className={styles.tip}>PPT를 만들 때는 <strong>‘슬라이드’</strong>를 고른 뒤 <strong>‘슬라이드(PPTX) 만들기’</strong>를 누르세요. 추천 분야나 방향을 먼저 확인해야 하면 버튼의 안내를 따라가세요.</p>
        <details className={styles.help}><summary>{USER_GUIDE_HELP[2].question}<ChevronDown aria-hidden="true" size={20} /></summary><p>{USER_GUIDE_HELP[2].answer}</p></details>
      </GuideSection>

      <GuideSection id="review">
        <ol className={styles.stepList}>
          <li><strong>결과 위의 안내부터 읽으세요.</strong><p>보완할 내용이 있으면 표시된 항목을 먼저 확인하세요. 점검을 통과했더라도 실제 교육에 맞는지 내가 한 번 더 읽어야 합니다.</p></li>
          <li><strong>‘편집’을 눌러 필요한 부분을 고치세요.</strong><p>제목과 내용을 바꾸거나 필요한 부분만 AI로 다시 만들 수 있습니다. 수정안은 원본과 비교한 뒤 적용하세요.</p></li>
          <li><strong>저장한 뒤 필요한 파일로 받으세요.</strong><p>‘저장’ 또는 ‘수정 저장’을 누르고 ‘저장됨’을 확인하세요. 훈련계획·교안은 한글(HWPX) 또는 워드(DOCX), 슬라이드는 파워포인트(PPTX) 파일로 받습니다.</p></li>
        </ol>
        <details className={styles.help}>
          <summary>PPT를 더 읽기 좋게 다듬으려면?<ChevronDown aria-hidden="true" size={20} /></summary>
          <div className={styles.helpContent}>
            <ul className={styles.bulletList}>
              <li><strong>내용이 많으면 ‘장 나누기’:</strong> 나눌 수 있는 장에서 사용하세요. 마음에 들지 않으면 ‘나누기 되돌리기’를 누르세요.</li>
              <li><strong>원문 그림이 작으면 ‘원문 확대 범위’:</strong> 상단·가운데·하단 중 필요한 부분을 고르세요. 전체 페이지로 되돌릴 수도 있습니다.</li>
              <li><strong>완성 전 ‘크게 보기’:</strong> 글자, 그림, 장 순서를 살핀 뒤 PPTX를 받으세요. 다운로드한 파일도 발표할 기기에서 열어 확인하세요.</li>
            </ul>
            <SourceIllustration />
          </div>
        </details>
        <details className={styles.help}><summary>{USER_GUIDE_HELP[3].question}<ChevronDown aria-hidden="true" size={20} /></summary><p>{USER_GUIDE_HELP[3].answer}</p></details>
      </GuideSection>

      <GuideSection id="resume">
        <div className={styles.storageList}>{USER_GUIDE_STORAGE_ITEMS.map((item) => <div key={item.title} className={styles.storageItem}><h3>{item.title}</h3><div><p>{item.description}</p><p className={styles.storageAction}>{item.action}</p></div></div>)}</div>
        <p className={styles.tip}><strong>화면을 닫기 전에 보관 상태를 확인하세요.</strong> 초안이 보관되었다는 표시를 확인하세요. 보관이나 저장 실패 안내가 보이면 내용을 복사해 둔 뒤 다시 시도하세요.</p>
        <p>두 목록은 <strong>AI 자료제작 화면 아래</strong>에 접혀 있습니다. 제목 옆의 <strong>‘펼치기’</strong>를 누르세요. 저장한 자료가 많으면 <strong>‘전체 보기’</strong>를 이용하세요.</p>
        <Link href="/generate" className={styles.textLink}>이어서 작업할 자료 찾기<ArrowRight aria-hidden="true" size={18} /></Link>
      </GuideSection>

      <GuideSection id="library">
        <div className={styles.libraryFeature}>
          <FileText aria-hidden="true" size={28} />
          <div><h3>자료실은 원본을 찾는 곳입니다.</h3><p>자료 제목을 입력하거나 분야·난이도를 고르세요. 내용을 문장으로 물어보고 싶다면 AI 튜터를 이용하세요.</p><Link href="/docs" className={styles.textLink}>자료실 열기<ArrowRight aria-hidden="true" size={18} /></Link></div>
        </div>
        <dl className={styles.otherMenus}>
          <div><dt><Link href="/generate/shared">동료가 만든 자료 보기</Link></dt><dd>AI 자료제작 상단에서 엽니다. 필요한 공유 자료를 내 자료로 복제한 뒤 수정할 수 있습니다.</dd></div>
          <div><dt><Link href="/news">구조 동향</Link></dt><dd>최근 구조 관련 소식을 확인합니다. 자세한 내용은 기사 원문에서 읽으세요.</dd></div>
          <div><dt><Link href="/notices">공지사항</Link></dt><dd>이용 안내와 새 공지를 확인합니다.</dd></div>
          <div><dt><Link href="/me">마이페이지</Link></dt><dd>내 계정 정보를 확인하고 저장한 자료를 다시 엽니다.</dd></div>
        </dl>
      </GuideSection>

      <footer className={styles.footer}><p><strong>다시 보고 싶을 때</strong><br />메뉴의 ‘사용설명서’를 열면 언제든 이 안내로 돌아올 수 있습니다.</p><a href="#start" className={styles.textLink}>처음 사용 순서로<ArrowRight aria-hidden="true" size={18} /></a></footer>
    </article>
  );
}
