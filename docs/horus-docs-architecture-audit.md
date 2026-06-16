# Horus documentation architecture audit

**Ticket:** HOR-166  
**Scope:** Audit the LeadCall documentation architecture and recommend a foundation for Horus docs.  
**Date:** 2026-06-16  
**Auditor:** Kimi (agent:kimi)

---

## 1. Executive summary

LeadCall ships a self-contained documentation site inside its Next.js marketing app. The architecture is small, strongly typed, and already solves the problems Horus will face in HOR-167 through HOR-174: navigation, search, on-page TOC, prev/next links, SEO, sitemaps, and multi-language support.

**Recommendation for Horus:** reuse the same architectural pattern. Create a dedicated `apps/horus-docs` Next.js app (or a docs package) that mirrors LeadCall's content model, components, and routing, but strips the marketing-page surface and adapts the content shape for technical docs (CLI reference, connector setup, investigation tutorials).

This avoids adopting a second documentation framework and lets Horus inherit a battle-tested content model and UX.

---

## 2. Current state of Horus docs

Horus already maintains a `docs/` directory with ~30 Markdown files:

```text
docs/
├── architecture.md
├── implementation-plan.md
├── risk-analysis.md
├── agent-workflow.md
├── evidence-model.md
├── investigation-graph.md
├── cause-scoring.md
├── conversational-investigation.md
├── install.md
├── provider-setup.md
├── connector-setup.md
├── local-providers.md
├── elasticsearch-field-mapping.md
├── config-path-precedence.md
├── cli-exit-codes.md
├── troubleshooting.md
├── v0.1-readiness-gate.md
├── axon-*.md
├── source-*.md
└── scenarios/
    └── zoho-sync-delay.md
```

**Strengths**

- Content is already written and grouped by topic.
- Architecture and planning docs are detailed and evidence-based.
- Markdown keeps the content portable.

**Gaps**

- No rendered documentation site.
- No shared layout, sidebar, or navigation.
- No search, on-page TOC, or prev/next links.
- No cross-linking from the README/landing page to docs.
- No SEO metadata, sitemap, or JSON-LD.
- No CLI command reference formatted as a docs page.
- NoGetting Started page tuned for end users.
- Content is author-centric (deep architecture) rather than reader-centric (task-oriented).

---

## 3. LeadCall documentation architecture

LeadCall's docs live inside the same Next.js app as its marketing site, under `app/docs` and `app/[locale]/docs`. The implementation is ~2,000 lines of typed content + UI and has been in production for the product's public site.

### 3.1 Routing

| Route           | File                       | Purpose                |
| --------------- | -------------------------- | ---------------------- |
| `/docs`         | `app/docs/page.tsx`        | Docs index (slug = "") |
| `/docs/:slug`   | `app/docs/[slug]/page.tsx` | Individual doc page    |
| `/docs` (TR/AR) | `app/[locale]/docs/*`      | Localized variants     |

- `generateStaticParams` builds every slug at build time.
- `dynamicParams = false` gives a hard 404 for unknown slugs.
- Locale routing uses `next-intl`; English is at root, Turkish and Arabic are prefixed.

### 3.2 Content model

Content is authored as typed TypeScript objects rather than Markdown/MDX. The core types live in `lib/docs.ts`:

```ts
export type DocBlock =
  | { type: 'h2'; id: string; text: string }
  | { type: 'h3'; id: string; text: string }
  | { type: 'p'; text: string }
  | { type: 'ul'; items: readonly string[] }
  | { type: 'ol'; items: readonly string[] }
  | { type: 'callout'; tone: 'info' | 'tip' | 'warning'; title?: string; text: string }
  | { type: 'table'; headers: readonly string[]; rows: readonly (readonly string[])[] }
  | { type: 'hr' };

export interface DocPage {
  slug: string;
  title: string;
  description: string;
  blocks: readonly DocBlock[];
  faqs?: readonly DocFaq[];
}

export interface DocGroup {
  title: string;
  items: readonly DocNavItem[];
}
```

**Why this matters for Horus**

- The model is intentionally narrow. It supports the elements that actually appear in product docs: headings, paragraphs, lists, tables, callouts, and FAQs.
- It removes the need for an MDX parser, remark plugins, or front-matter handling.
- TypeScript gives autocomplete and compile-time validation.
- Translations are stored in the same file as overrides (`DOC_PAGE_TRANSLATIONS`), which is easy to diff and review.

### 3.3 Navigation

`DOC_GROUPS_EN` defines the sidebar structure:

```ts
const DOC_GROUPS_EN: readonly DocGroup[] = [
  {
    title: 'Overview',
    items: [
      { slug: '', title: 'Introduction' },
      { slug: 'core-concepts', title: 'Core concepts' },
      { slug: 'realtime-features', title: 'Real-time features' },
    ],
  },
  {
    title: 'Setup',
    items: [
      { slug: 'getting-started', title: 'Getting started' },
      { slug: 'sync-date-range', title: 'Choosing your sync date range' },
      { slug: 'zoho-crm', title: 'Zoho CRM' },
      ...
    ],
  },
  ...
]
```

A parallel `DOC_GROUPS_BY_LOCALE` map holds Turkish and Arabic navigation labels.

The sidebar (`components/docs/DocsSidebar.tsx`) is:

- Fixed on desktop (`lg`), drawer on mobile.
- Highlights the active page.
- Includes a search trigger, language switcher, and "back to site" link.
- Fully accessible (aria-labels, keyboard focus).

### 3.4 Search

`DocsSearch.tsx` implements an in-page command palette:

- Triggered by a sidebar button or `Cmd/Ctrl + K`.
- Filters against title, description, and page headings.
- Keyboard navigable (arrow keys, Enter, Escape).
- Search index is precomputed server-side via `getDocSearchIndex(locale)`.

The search index is built from the same typed `DocPage[]` array, so it stays in sync with content automatically.

### 3.5 Page chrome

`DocsPageShell.tsx` provides:

- Breadcrumb (`Documentation > Current page`).
- Page title + description.
- `DocContent` renderer for the typed blocks.
- FAQ section (renders `faqs` as structured Q&A).
- Related links from i18n messages.
- Prev/next navigation (`getAdjacentPages`).
- JSON-LD for the article and FAQ pages.

`DocsOnThisPage.tsx` builds a right-hand TOC from `h2`/`h3` blocks with intersection-observer active-state highlighting.

### 3.6 Rendering

`DocContent.tsx` maps each `DocBlock` to a styled component:

- `h2` / `h3` with `scroll-mt-24` and `id` attributes.
- `p`, `ul`, `ol` with `renderInline` for backtick code spans.
- `callout` with info/tip/warning tones and icons.
- `table` with responsive overflow wrapper.
- `hr` for section breaks.

Styling uses Tailwind CSS v4 with custom semantic tokens (`text-ink`, `bg-canvas-muted`, `border-line`, etc.).

### 3.7 SEO

- `lib/docs-page.ts` builds Next.js `Metadata` per page.
- `lib/seo.ts` provides canonical paths, alternates, and sitemap entries.
- `app/sitemap.ts` emits entries for `docsIndex` and `docsSlug` with priorities and alternates.
- `components/seo/JsonLd.tsx` renders `DocArticleJsonLd` and `FaqPageJsonLd`.

### 3.8 Internationalization

- `next-intl` for UI labels and related links.
- `i18n/routing.ts` defines locales (`en`, `tr`, `ar`) and RTL handling.
- Doc content translations are stored as structured overrides in `DOC_PAGE_TRANSLATIONS`, not as separate files.

### 3.9 Dependencies

The docs layer relies only on the app's existing stack:

```text
next
next-intl
react / react-dom
lucide-react
tailwindcss v4
```

No additional documentation framework is required.

---

## 4. Gap analysis: LeadCall architecture → Horus needs

| Capability                | LeadCall                 | Horus today      | Needed for Horus docs |
| ------------------------- | ------------------------ | ---------------- | --------------------- |
| Rendered docs site        | ✅ Next.js app           | ❌ Markdown only | ✅                    |
| Sidebar navigation groups | ✅ Typed groups          | ❌               | ✅                    |
| Full-text search          | ✅ Cmd+K palette         | ❌               | ✅ (HOR-173)          |
| On-page TOC               | ✅ Intersection observer | ❌               | ✅                    |
| Prev/next links           | ✅ From nav order        | ❌               | ✅                    |
| Breadcrumbs               | ✅                       | ❌               | ✅                    |
| Callouts / tables         | ✅ Typed blocks          | ⚠️ Raw Markdown  | ✅                    |
| SEO + sitemap             | ✅                       | ❌               | ✅                    |
| Multi-language            | ✅ EN/TR/AR              | ❌               | Optional v1.1         |
| CLI command reference     | ❌ (product docs)        | ❌               | ✅ (HOR-169)          |
| Connector setup guides    | ❌                       | ⚠️ Scattered     | ✅ (HOR-171)          |
| Investigation tutorial    | ❌                       | ⚠️ One scenario  | ✅ (HOR-172)          |
| Links from landing/README | ⚠️ Via marketing site    | ❌               | ✅ (HOR-174)          |

**Key insight:** LeadCall's architecture covers the _presentation_ and _UX_ gaps that Horus tickets HOR-167, HOR-173, and HOR-174 are meant to close. Horus still needs to author its own _content_ (HOR-168, HOR-169, HOR-170, HOR-171, HOR-172), but it does not need to invent a new docs framework.

---

## 5. Recommendation

### 5.1 Adopt LeadCall's pattern for Horus

Create a new package or app that ports the LeadCall docs architecture with these adaptations:

1. **Location:** `apps/horus-docs` (or `packages/docs-site` if it should be publishable separately).
2. **Framework:** Next.js 15+ with `next-intl`, Tailwind CSS v4, and the same typed-block content model.
3. **Content source:** Start by porting existing `docs/*.md` files into the `DocPage[]` array. This is the fastest path to a rendered site and keeps the content under version control.
4. **Navigation groups** tuned for a developer/SRE audience:
   - Overview → Introduction, What Horus is, Architecture
   - Getting Started → Install, Setup, First investigation
   - CLI Reference → Commands, Exit codes, Configuration
   - Source Intelligence → Axon integration, Queue stitcher, Repo registry
   - Connectors → Elasticsearch, Grafana, MongoDB, BullMQ, Redis, Git
   - Investigations → Walkthrough, Scenarios, Evidence model
   - Reference → Troubleshooting, Glossary, Roadmap
5. **Search:** port `DocsSearch.tsx` and `getDocSearchIndex()`.
6. **On-page TOC + prev/next:** port `DocsOnThisPage.tsx` and `getAdjacentPages()`.
7. **SEO:** port `docs-page.ts`, `JsonLd.tsx`, and sitemap integration.
8. **Landing links:** expose `/docs` from `horus.sh` and add docs links to README + package metadata.

### 5.2 Alternative: keep Markdown, add a static-site generator

Options like VitePress, Docusaurus, Astro Starlight, or Mintlify can render the existing Markdown with less up-front code. Trade-offs:

- **Pros:** Existing Markdown files render immediately; less custom code.
- **Cons:** A second framework in the repo; theming/landing integration is harder; search/TOC/SEO are framework-dependent; Horus already owns a Next.js app skill from LeadCall.

**Verdict:** Reuse the LeadCall Next.js docs architecture. It is already proven, typed, and designed to integrate with the marketing/landing surface. A static-site generator would introduce a parallel toolchain.

### 5.3 Do not do

- Do not build docs inside `apps/horus` (the CLI composition root). The CLI bundle should stay small.
- Do not use MDX unless there is a strong need for interactive examples; the typed-block model is simpler and sufficient.
- Do not add i18n in v0 unless explicitly required; keep the structure ready but ship English first.

---

## 6. Implementation sketch for HOR-167

HOR-167 should create the foundation. Based on this audit, the acceptance criteria for HOR-167 are:

1. New `apps/horus-docs` Next.js app exists with:
   - `next.config.ts` configured for static export to `dist/`.
   - Tailwind + global CSS tokens matching Horus branding.
   - `app/docs/page.tsx` and `app/docs/[slug]/page.tsx` routes.
2. `lib/docs.ts` with:
   - `DocBlock`, `DocPage`, `DocGroup`, `DocNavItem`, `DocUiLabels` types.
   - `DOC_GROUPS` for the Horus nav structure.
   - `DOC_PAGES` with at least an `introduction` page.
3. Components:
   - `DocsSidebar` (desktop + mobile drawer).
   - `DocsPageShell` (breadcrumb, title, content, prev/next).
   - `DocContent` (heading/paragraph/list/table/callout renderers).
   - `DocsOnThisPage` (right-hand TOC).
4. Search:
   - `DocsSearch` command palette.
   - `getDocSearchIndex()` precomputing title/description/headings.
5. SEO:
   - `app/sitemap.ts` including docs pages.
   - `docsPageMetadata()` helper.
6. Validation:
   - `pnpm build` in `apps/horus-docs` succeeds.
   - `pnpm lint` passes.
   - At least one docs page renders at `/docs`.

HOR-168 through HOR-172 then populate `DOC_PAGES` and `DOC_GROUPS` with the actual Horus content.

---

## 7. Risks

| Risk                                                                                            | Mitigation                                                                               |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Porting LeadCall code copies marketing-specific assumptions (dashboard CTA, language switcher). | Strip those components; keep only docs primitives.                                       |
| Tailwind v4 custom tokens differ between LeadCall and Horus.                                    | Define a Horus token set in the docs app; do not share CSS with LeadCall.                |
| Typed-block content is more verbose than Markdown.                                              | Accept the trade-off for type safety; later add a Markdown→DocBlock migration if needed. |
| Existing Markdown content drifts from the new docs site.                                        | Treat the new site as canonical once HOR-167 lands; archive or redirect old Markdown.    |
| Maintenance of two Next.js apps.                                                                | Use pnpm workspace + shared ESLint/Prettier config; do not share runtime code.           |

---

## 8. Follow-ups

- HOR-167: Create `apps/horus-docs` using this audit as the spec.
- HOR-168: Write the Getting Started doc page.
- HOR-169: Build CLI command reference pages from `packages/cli/src/commands`.
- HOR-170: Port/source-intelligence docs (`docs/axon-*.md`, `docs/source-*.md`).
- HOR-171: Port connector docs (`docs/connector-setup.md`, `docs/provider-setup.md`, etc.).
- HOR-172: Write investigation walkthrough from `docs/scenarios/zoho-sync-delay.md` or a new Horus-native example.
- HOR-173: Polish search + navigation UX (already present in the ported architecture).
- HOR-174: Link `/docs` from `horus.sh`, README, and package metadata.

---

## 9. Files referenced in this audit

LeadCall (reference architecture):

- `/Users/mhmdh/Documents/projects/meritt-dev/leadCallLanding/app/docs/page.tsx`
- `/Users/mhmdh/Documents/projects/meritt-dev/leadCallLanding/app/docs/[slug]/page.tsx`
- `/Users/mhmdh/Documents/projects/meritt-dev/leadCallLanding/app/docs/layout.tsx`
- `/Users/mhmdh/Documents/projects/meritt-dev/leadCallLanding/lib/docs.ts`
- `/Users/mhmdh/Documents/projects/meritt-dev/leadCallLanding/lib/docs-page.ts`
- `/Users/mhmdh/Documents/projects/meritt-dev/leadCallLanding/lib/docs-shell.ts`
- `/Users/mhmdh/Documents/projects/meritt-dev/leadCallLanding/components/docs/DocsPageShell.tsx`
- `/Users/mhmdh/Documents/projects/meritt-dev/leadCallLanding/components/docs/DocsSidebar.tsx`
- `/Users/mhmdh/Documents/projects/meritt-dev/leadCallLanding/components/docs/DocContent.tsx`
- `/Users/mhmdh/Documents/projects/meritt-dev/leadCallLanding/components/docs/DocsSearch.tsx`
- `/Users/mhmdh/Documents/projects/meritt-dev/leadCallLanding/components/docs/DocsOnThisPage.tsx`
- `/Users/mhmdh/Documents/projects/meritt-dev/leadCallLanding/app/sitemap.ts`

Horus (current state):

- `/Users/mhmdh/Documents/projects/lab/horus/docs/*.md`
- `/Users/mhmdh/Documents/projects/lab/horus/README.md`
- `/Users/mhmdh/Documents/projects/lab/horus/apps/horus/package.json`
- `/Users/mhmdh/Documents/projects/lab/horus/package.json`

---

**Conclusion:** LeadCall's documentation architecture is the right template for Horus. The fastest, lowest-risk path is to port its typed content model, routing, components, and search into a new `apps/horus-docs` package, then populate it with Horus-specific content in the downstream tickets.
