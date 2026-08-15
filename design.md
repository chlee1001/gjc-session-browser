# Design — GJC Sessions

이 파일은 고정된 디자인 시스템이다. 이후 Hallmark 작업은 먼저 이 문서를 읽고
장르, 색상, 글꼴, 간격, 동작 원칙을 따른다. 변경할 때는 이 문서를 함께 수정한다.

## System

- Genre · modern-minimal
- Macrostructure · Index-First
- Theme · Cobalt
- Axes · cool-light / grotesk-sans / electric-blue
- Navigation · N13 Inline Command Search
- Footer · Ft2 Inline Rule
- Tone · technical

## Tokens

`tokens.css`가 원본이다.

```css
:root {
  --color-paper: oklch(98.5% 0.004 250);
  --color-paper-2: oklch(96.5% 0.007 250);
  --color-ink: oklch(24% 0.02 258);
  --color-body: oklch(34% 0.018 257);
  --color-rule: oklch(88% 0.01 252);
  /* accent·success·danger는 soft 배경 위 11px 본문으로도 쓰인다. AA 4.5:1을 넘는 명도만 허용한다. */
  --color-accent: oklch(50% 0.2 258);
  --color-accent-ink: oklch(98.5% 0.004 250);
  --color-success: oklch(48% 0.14 150);
  --color-danger: oklch(52% 0.19 25);
  --color-focus: oklch(50% 0.22 256);

  --font-display: "Space Grotesk", ui-sans-serif, sans-serif;
  --font-body: "Space Grotesk", ui-sans-serif, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;

  /* 4pt 간격: --space-3xs부터 --space-3xl까지. */
  /* 글자 크기: --text-xs부터 --text-display까지. */

  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --dur-fast: 120ms;
  --dur-base: 200ms;
  --dur-slow: 320ms;

  --radius-xs: 0.25rem;
  --radius-sm: 0.375rem;
  --radius-md: 0.625rem;

  /* 모든 인터랙티브 요소의 단일 높이. 개별 버튼에 높이를 직접 적지 않는다. */
  --control-h: 2.75rem;
}
```

회색 계열 본문 토큰은 ink(24%) · body(34%) · muted(54%) 세 단계만 쓴다.
이보다 엷은 회색을 글자에 쓰지 않는다.

## Component voice

- Primary · cobalt fill · 6px radius · `--control-h`. 확정 동작과 파괴적 확인에만 쓴다.
- Secondary · cool-paper outline · 같은 반경과 높이. 설정성 동작은 여기에 둔다.
- Rows · 카드 대신 가는 구분선으로 나눈 인덱스
- Row entry · 행 전체를 버튼으로 감싸지 않는다. 제목만 버튼으로 두고 `::after`로 클릭 영역만 행 전체로 늘린다.
- Filters · 걸러보는 모든 조건은 하나의 칩 그룹으로 표현한다. 같은 행위에 라디오·링크를 섞지 않는다.
- Status · 상태는 붙은 세그먼트 하나로 묶는다. 행에 남는 컨트롤 덩어리는 상태와 보관 둘뿐이다.
- Selection · 선택은 모드다. 모드 밖에서는 행에 체크박스를 두지 않는다.
- Drill-down · 목록 행의 상세는 인라인으로 펼치지 않고 모달로 열린다. 행은 리듬을 유지하고 트리거만 행 안에 남는다.
- Dead end · 목록을 보여 주면 그 항목으로 갈 길을 같이 둔다. 읽기만 되는 목록은 만들지 않는다.
- Modal chaining · 모달에서 다음 모달로 갈 땐 겹치지 않고 갈아끼운다. 포커스는 처음 트리거로 돌아간다.
- Modal · 모든 모달은 같은 껍데기를 쓴다. 뒷면 inert · 스크롤 잠금 · Tab 가두기 · Escape 닫기 · 트리거로 포커스 복귀.
- Search · 화면에 드러난 검색 버튼과 `⌘K`/`Ctrl+K` 명령 패널
- Accent · 포커스, 진행 상태, 주 동작, 선택된 상태에만 사용. 장식에는 쓰지 않는다.

## Motion stance

- 화면 진입 애니메이션은 쓰지 않는다.
- 명령 패널과 상세 패널은 opacity와 짧은 세로 이동만 사용한다.
- 점멸은 화면 전체에서 하나만 둔다. 인덱싱 상태 점이 그 하나다.
- `prefers-reduced-motion`에서는 전환 시간을 150ms 이하로 줄인다.

## Data rows

- 수치가 여러 행에 걸치면 행마다 그리드를 잡지 않는다. 목록을 그리드 주인으로 두고 행은 `subgrid`로 붙인다.
- 행별 `auto` 트랙은 열이 밀린다. 막대 끝·수치 오른쪽 끝·버튼 왼쪽 끝은 전 행이 같아야 한다.
- 숫자는 `font-variant-numeric: tabular-nums`로 고정폭을 쓴다.

## Contrast

- 본문 글자는 배경 대비 4.5:1 이상을 무조건 만족한다. 11px 모노 라벨도 예외가 아니다.
- accent·success·danger를 soft 배경 위에 글자로 올릴 땐 그 쌍으로 대비를 재야 한다.
- 토큰을 바꿀 땐 이 문서와 `tokens.css`를 함께 고친다.

## Responsive rules

- `html`과 `body`는 `overflow-x: clip`을 유지한다.
- 768px 이하에서는 본문을 단일 흐름으로 바꾸고 필터는 두 열로 접는다.
- 414px 이하에서는 필터와 세션 메타데이터를 한 열로 표시한다.
- 모든 터치 대상은 `--control-h`(44px) 이상이며 버튼 문구는 줄바꿈하지 않는다.
- 인덱스가 먼저다. 1440×900에서 첫 화면에 세션 행이 최소 세 개 들어와야 한다.
- 분석 뷰(모델별 사용량)는 접힌 상태로 시작한다.

## Exports

`tokens.css`가 이 프로젝트의 토큰 원본이다. Tailwind v4 `@theme`, DTCG
`tokens.json`, shadcn/ui CSS 변수는 필요할 때 이 절에 추가한다.
