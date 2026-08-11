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
  --color-accent: oklch(58% 0.2 256);
  --color-accent-ink: oklch(98.5% 0.004 250);
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
}
```

## Component voice

- Primary · cobalt fill · 6px radius · 44px minimum height
- Secondary · cool-paper outline · 같은 반경과 높이
- Rows · 카드 대신 가는 구분선으로 나눈 인덱스
- Search · 화면에 드러난 검색 버튼과 `⌘K`/`Ctrl+K` 명령 패널
- Accent · 포커스, 진행 상태, 주 동작에만 사용

## Motion stance

- 화면 진입 애니메이션은 쓰지 않는다.
- 명령 패널은 opacity와 짧은 세로 이동만 사용한다.
- 상태 점은 인덱싱 중에만 점멸한다.
- `prefers-reduced-motion`에서는 전환 시간을 150ms 이하로 줄인다.

## Responsive rules

- `html`과 `body`는 `overflow-x: clip`을 유지한다.
- 768px 이하에서는 본문과 필터를 단일 흐름으로 재배치한다.
- 414px 이하에서는 필터와 세션 메타데이터를 한 열로 표시한다.
- 모든 터치 대상은 최소 44px이며 버튼 문구는 줄바꿈하지 않는다.

## Exports

`tokens.css`가 이 프로젝트의 토큰 원본이다. Tailwind v4 `@theme`, DTCG
`tokens.json`, shadcn/ui CSS 변수는 필요할 때 이 절에 추가한다.
