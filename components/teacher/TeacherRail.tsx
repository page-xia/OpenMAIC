'use client';

/**
 * The teacher operations rail — the Pro workspace's left rail, rebuilt on the
 * SAME visual layer (`workspace-shell.css` tokens and `ws-*` classes, imported
 * by the layout so the scope is shared, not forked) and fed by the teacher
 * courseware API instead of the agent workbench's data layer.
 *
 * Why a sibling component rather than reusing `WorkspaceRail` itself: that
 * rail is welded to its data sources — `useHomeDiscovery` (browser/PG stage
 * lists), the agent owner-session SSE, drag-order persistence, folders. The
 * teacher backend has one list (courses with draft/published status), no
 * folders, no sessions. Porting the SHELL (tabs, find row, paged rows, the
 * 32px rows, collapse, resize, foot utilities) keeps the two surfaces
 * pixel-identical while each keeps an honest data layer. When this rail
 * diverges visually from WorkspaceRail, fix BOTH — see AGENTS.md §7.
 *
 * Structure mirrors WorkspaceRail exactly: header (brand + fold) → seam →
 * primary action row → tabs → find row → paged list → foot utilities.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useRouter, usePathname } from 'next/navigation';
import {
  BookOpen,
  GraduationCap,
  Languages,
  LogOut,
  Monitor,
  Moon,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  Sun,
  Ticket,
  Users,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useTheme } from '@/lib/hooks/use-theme';
import { useBrand } from '@/lib/brand/brand-context';
import { PaneFoldButton } from '@/components/workbench/workspace/PaneFoldButton';
import { SettingsDialog } from '@/components/settings';
import { startTeacherSettingsMirror } from '@/lib/persistence/teacher-settings-mirror';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { supportedLocales } from '@/lib/i18n';
import {
  RAIL_INITIAL_ROWS,
  pageList,
  nextPage,
  type PageMap,
  withPages,
} from '@/lib/workbench/workspace-paging';

export interface TeacherRailCourse {
  readonly id: string;
  readonly title: string;
  readonly status: 'draft' | 'published' | 'archived';
  readonly sceneCount: number;
  readonly updatedAt: number;
}

export type TeacherRailTab = 'all' | 'draft' | 'published';

interface TeacherRailProps {
  readonly courses: readonly TeacherRailCourse[];
  readonly state: 'loading' | 'ready' | 'error';
  readonly activeCourseId: string | null;
  readonly onReload: () => void;
  readonly teacherName: string;
  readonly isAdmin: boolean;
  readonly onLogout: () => void;
}

const RAIL_WIDTH_DEFAULT = 256;
const RAIL_WIDTH_MIN = 200;
const RAIL_WIDTH_MAX = 420;
const RAIL_WIDTH_STORAGE_KEY = 'teacher.rail.width';
const RAIL_TAB_STORAGE_KEY = 'teacher.rail.tab';
const RAIL_COLLAPSE_STORAGE_KEY = 'teacher.rail.collapsed';

function clampRailWidth(value: number): number {
  return Math.min(RAIL_WIDTH_MAX, Math.max(RAIL_WIDTH_MIN, value));
}

function parseStoredNumber(value: string | null, fallback: number): number {
  const parsed = value === null ? Number.NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const TABS: readonly { id: TeacherRailTab; i18nKey: string }[] = [
  { id: 'all', i18nKey: 'teacherRail.tabAll' },
  { id: 'draft', i18nKey: 'teacherRail.tabDraft' },
  { id: 'published', i18nKey: 'teacherRail.tabPublished' },
];

/** Same three options the workspace ThemeToggle offers, in the same order. */
const THEME_MENU_OPTIONS = [
  { value: 'light', icon: Sun },
  { value: 'dark', icon: Moon },
  { value: 'system', icon: Monitor },
] as const;

/** Shared highlight for the active theme/locale row in the ⋯ menu. */
const MENU_ACTIVE_ITEM = 'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400';

export function TeacherRail({
  courses,
  state,
  activeCourseId,
  onReload,
  teacherName,
  isAdmin,
  onLogout,
}: TeacherRailProps) {
  const { t, locale, setLocale } = useI18n();
  const { theme, setTheme } = useTheme();
  const router = useRouter();
  const pathname = usePathname();
  const brand = useBrand();
  const rootRef = useRef<HTMLElement>(null);
  // The same dialog the Pro rail opens — mounted here, opened in place. The
  // teacher settings mirror must be live while it is open, so dialog saves
  // land in the server's system_settings overlay (idempotent start).
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    startTeacherSettingsMirror();
  }, []);

  // ── Width drag + collapse, mirroring WorkspaceShell's useRailWidth ──────
  const railWidth = useRef(RAIL_WIDTH_DEFAULT);
  const [collapsed, setCollapsed] = useState(false);
  const paintWidth = useCallback((next: number) => {
    railWidth.current = next;
    rootRef.current?.style.setProperty('--ws-rail-w', `${next}px`);
  }, []);
  useLayoutEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- storage is client-only; restored once on mount, the same trade `WorkspaceShell.usePaneCollapse` makes */
    try {
      paintWidth(
        clampRailWidth(
          parseStoredNumber(localStorage.getItem(RAIL_WIDTH_STORAGE_KEY), RAIL_WIDTH_DEFAULT),
        ),
      );
    } catch {
      // An unwritable store only costs the preference.
    }
    setCollapsed(localStorage.getItem(RAIL_COLLAPSE_STORAGE_KEY) === '1');
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [paintWidth]);
  const toggleCollapsed = useCallback(() => {
    setCollapsed((current) => {
      try {
        localStorage.setItem(RAIL_COLLAPSE_STORAGE_KEY, current ? '0' : '1');
      } catch {
        // See above.
      }
      return !current;
    });
  }, []);

  // ── Tab + find, each keeping its own query like the workbench rail ─────
  const [tab, setTab] = useState<TeacherRailTab>('all');
  useLayoutEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- storage is client-only; restored once on mount */
    try {
      const stored = localStorage.getItem(RAIL_TAB_STORAGE_KEY);
      if (stored === 'all' || stored === 'draft' || stored === 'published') setTab(stored);
    } catch {
      // See above.
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);
  const selectTab = useCallback((next: TeacherRailTab) => {
    setTab(next);
    try {
      localStorage.setItem(RAIL_TAB_STORAGE_KEY, next);
    } catch {
      // See above.
    }
  }, []);
  const [query, setQuery] = useState('');
  // The page window is keyed by the list it was opened for: a query or tab
  // change swaps the list, and the stale window is discarded by comparison at
  // render time — no effect, no reset pass.
  const EMPTY_PAGES: PageMap = useMemo(() => new Map<string, number>(), []);
  const [paged, setPaged] = useState<{ listId: string; map: PageMap }>({
    listId: '',
    map: EMPTY_PAGES,
  });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return courses.filter((course) => {
      if (tab === 'draft' && course.status !== 'draft') return false;
      if (tab === 'published' && course.status !== 'published') return false;
      return !q || course.title.toLowerCase().includes(q);
    });
  }, [courses, query, tab]);

  const listId = `${tab}:${query.trim()}`;
  const pages = paged.listId === listId ? paged.map : EMPTY_PAGES;
  const openCourse = useCallback(
    (id: string) => {
      router.push(`/teacher/courses/${id}`);
    },
    [router],
  );

  return (
    <nav
      ref={rootRef}
      data-testid="teacher-rail"
      aria-label={t('teacherRail.navAria')}
      style={{ ['--ws-rail-w' as string]: `${RAIL_WIDTH_DEFAULT}px`, width: 'var(--ws-rail-w)' }}
      className="ws-rail relative z-10 hidden h-full shrink-0 flex-col md:flex"
    >
      {/* Header: brand + fold — the same shape, minus the Pro badge (the Pro
          switch lives in the workspace; this rail is the ordinary mode). */}
      <div className="flex h-16 shrink-0 items-center gap-2 px-4">
        <button
          type="button"
          data-testid="teacher-rail-home"
          onClick={() => router.push('/teacher/courses')}
          aria-label={t('teacherRail.homeAria')}
          className="-ml-1.5 flex items-center gap-2 rounded-md px-1.5 py-1"
        >
          <img
            src={brand.logoSrc}
            alt=""
            aria-hidden="true"
            className="h-[21px] w-auto max-w-[110px] shrink-0"
          />
        </button>
        {collapsed ? null : (
          <span className="truncate text-[12px] font-medium text-[color:var(--ws-ink-mute)]">
            {t('teacherRail.brandSub')}
          </span>
        )}
        <PaneFoldButton
          testId="teacher-rail-collapse"
          label={collapsed ? t('workspace.expandNav') : t('workspace.collapseNav')}
          direction="left"
          expanded={!collapsed}
          className="ml-auto"
          onClick={toggleCollapsed}
        />
      </div>

      <div className="ws-seam-rail mx-4 shrink-0" aria-hidden="true" />

      {/* Destinations — one row per destination, the workbench rail's own
          mini-row shape, so the two rails read as siblings. */}
      <div className="flex shrink-0 flex-col gap-0.5 px-3 pb-1 pt-3">
        <RailLink
          label={t('teacherRail.coursesNav')}
          active={!pathname.startsWith('/teacher/invites')}
          collapsed={collapsed}
          onClick={() => router.push('/teacher/courses')}
          icon={<BookOpen className="size-4 shrink-0" aria-hidden />}
        />
        <RailLink
          label={t('teacherRail.invitesNav')}
          active={pathname.startsWith('/teacher/invites')}
          collapsed={collapsed}
          onClick={() => router.push('/teacher/invites')}
          icon={<Ticket className="size-4 shrink-0" aria-hidden />}
        />
        <RailLink
          label={t('teacherRail.studentsNav')}
          active={pathname.startsWith('/teacher/students')}
          collapsed={collapsed}
          onClick={() => router.push('/teacher/students')}
          icon={<Users className="size-4 shrink-0" aria-hidden />}
        />
      </div>

      {/* Primary action — the workbench's "new conversation" row shape. */}
      <div className="flex shrink-0 items-center gap-2 px-3 pb-3 pt-3">
        <button
          type="button"
          data-testid="teacher-rail-new-course"
          onClick={() => router.push('/teacher/courses/new')}
          className="ws-new flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg px-3 text-[13px] font-medium focus-visible:outline-none"
        >
          <Plus className="size-4 shrink-0 opacity-50" aria-hidden="true" />
          <span className="min-w-0 truncate">{t('teacherRail.newCourse')}</span>
        </button>
      </div>

      {/* Tabs — one body, three views, the workbench's segmented control. */}
      <div
        role="tablist"
        aria-label={t('teacherRail.tabsAria')}
        className="ws-navtabs mx-3 flex shrink-0 items-stretch"
      >
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            data-testid={`teacher-rail-tab-${item.id}`}
            aria-selected={tab === item.id}
            tabIndex={tab === item.id ? 0 : -1}
            onClick={() => selectTab(item.id)}
            title={t(item.i18nKey)}
            className="ws-navtab flex min-w-0 flex-1 items-center justify-center"
          >
            <span className="ws-navtab-label min-w-0 truncate">{t(item.i18nKey)}</span>
          </button>
        ))}
      </div>

      {/* Find row — the workbench's findrow: always-visible icon+input. */}
      <div className="flex shrink-0 items-center gap-1.5 px-3 pb-2 pt-2.5">
        <div className="ws-find min-w-0 flex-1">
          <Search className="size-3.5 shrink-0" aria-hidden="true" />
          <input
            data-testid="teacher-rail-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                setQuery('');
              }
            }}
            placeholder={t('workspace.searchPlaceholder')}
            aria-label={t('workspace.searchAria', { section: t('workspace.sections.courses') })}
            className="ws-find-input min-w-0 flex-1"
          />
        </div>
      </div>

      {/* The paged list — same windowing contract as the workbench tree. */}
      <div
        role="tabpanel"
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2 pt-1.5"
      >
        {state === 'error' ? (
          <div className="px-2 py-1.5 text-[12px] text-[color:var(--ws-ink-mute)]">
            <p>{t('workspace.loadFailed')}</p>
            <button type="button" onClick={onReload} className="ws-more mt-1 h-7 px-2">
              {t('workspace.retry')}
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <p className="px-2 py-1.5 text-[12px] text-[color:var(--ws-ink-mute)]">
            {query ? t('workspace.searchEmpty') : t('workspace.coursesEmpty')}
          </p>
        ) : (
          <PagedRows
            id={listId}
            items={filtered}
            initial={RAIL_INITIAL_ROWS}
            pages={pages.get(listId) ?? 0}
            onMore={() =>
              setPaged({
                listId,
                map: withPages(
                  pages,
                  listId,
                  nextPage(filtered, pages.get(listId) ?? 0, { initial: RAIL_INITIAL_ROWS }),
                ),
              })
            }
            onCollapse={() => setPaged({ listId, map: withPages(pages, listId, 0) })}
            render={(course) => (
              <CourseRow
                key={course.id}
                course={course}
                active={course.id === activeCourseId}
                onClick={() => openCourse(course.id)}
              />
            )}
          />
        )}
      </div>

      {/* Foot utilities — the RailUtilities shape: seam + one row of quiet
          icon buttons. The name leads; the things a teacher acts on — settings
          and the ⋯ dropdown — sit at the corner. Everything less frequent
          (locale, theme, the student home, logout) lives in that dropdown.
          Collapsed rails keep the icons and drop the name. */}
      <div className="shrink-0" data-testid="teacher-rail-utilities">
        <div className="ws-seam-rail mx-4" aria-hidden="true" />
        <div
          aria-label={t('workspace.utilitiesAria')}
          className="ws-utils flex items-center gap-0.5 px-3 py-2.5"
        >
          {!collapsed ? (
            <span
              className="min-w-0 truncate text-[11px] text-[color:var(--ws-ink-mute)]"
              title={teacherName}
            >
              {teacherName}
            </span>
          ) : null}
          {/* shrink-0: the buttons keep their size and the name is what
              truncates when the two meet. */}
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            {isAdmin ? (
              <button
                type="button"
                data-testid="teacher-rail-settings"
                onClick={() => setSettingsOpen(true)}
                aria-label={t('settings.title')}
                title={t('settings.title')}
                className="ws-util-btn"
              >
                <Settings className="size-4" aria-hidden="true" />
              </button>
            ) : null}
            {/* The ⋯ opens a VERTICAL dropdown (Radix, portaled to the body so
                the rail's backdrop-filter cannot clip it): theme and language
                as submenus, the two destinations as plain labeled rows. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  data-testid="teacher-rail-overflow"
                  aria-label={t('workspace.moreUtilities')}
                  title={t('workspace.moreUtilities')}
                  className="ws-util-btn"
                >
                  <MoreHorizontal className="size-4" aria-hidden="true" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                data-testid="teacher-rail-overflow-panel"
                side="top"
                align="end"
                sideOffset={8}
                className="min-w-[176px]"
              >
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    {(() => {
                      const ActiveIcon =
                        THEME_MENU_OPTIONS.find((option) => option.value === theme)?.icon ??
                        Monitor;
                      return <ActiveIcon className="size-4" aria-hidden="true" />;
                    })()}
                    {t('settings.theme')}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {THEME_MENU_OPTIONS.map(({ value, icon: Icon }) => (
                      <DropdownMenuItem
                        key={value}
                        data-testid={`teacher-rail-overflow-theme-${value}`}
                        onClick={() => setTheme(value)}
                        className={cn(theme === value && MENU_ACTIVE_ITEM)}
                      >
                        <Icon className="size-4" aria-hidden="true" />
                        {t(`settings.themeOptions.${value}`)}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Languages className="size-4" aria-hidden="true" />
                    {t('settings.language')}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {supportedLocales.map((item) => (
                      <DropdownMenuItem
                        key={item.code}
                        data-testid={`teacher-rail-overflow-language-${item.code}`}
                        onClick={() => setLocale(item.code)}
                        className={cn(locale === item.code && MENU_ACTIVE_ITEM)}
                      >
                        {item.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  data-testid="teacher-rail-overflow-student-home"
                  onClick={() => router.push('/')}
                >
                  <GraduationCap className="size-4" aria-hidden="true" />
                  {t('teacherRail.studentHome')}
                </DropdownMenuItem>
                <DropdownMenuItem data-testid="teacher-rail-overflow-logout" onClick={onLogout}>
                  <LogOut className="size-4" aria-hidden="true" />
                  {t('teacherRail.logout')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </nav>
  );
}

/** One course row — the workbench `ws-row` anatomy: name, meta at the edge. */
/**
 * One destination row — the workbench mini-row shape (32px, glyph + name,
 * neutral pill hover, `ws-row-active` selection). Collapsed rails keep the
 * glyph with a tooltip and drop the name.
 */
function RailLink({
  label,
  active,
  collapsed,
  onClick,
  icon,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly collapsed: boolean;
  readonly onClick: () => void;
  readonly icon: ReactNode;
}) {
  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onClick}
            aria-label={label}
            aria-current={active ? 'page' : undefined}
            className="ws-util-btn ml-2"
          >
            {icon}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'ws-row ws-tree-row flex min-w-0 items-center gap-2 px-2 text-left',
        active && 'ws-row-active',
      )}
    >
      <span className="shrink-0 opacity-70">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-[13px]">{label}</span>
    </button>
  );
}

function CourseRow({
  course,
  active,
  onClick,
}: {
  readonly course: TeacherRailCourse;
  readonly active: boolean;
  readonly onClick: () => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      data-testid={`teacher-rail-course-${course.id}`}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      title={course.title}
      className={cn(
        // NO flex-1: this button is a direct child of the list's flex COLUMN
        // (the tabpanel above), so `flex: 1` would stretch every row
        // vertically to share the rail's leftover height. Rows keep their own
        // `.ws-tree-row` 32px; full width comes from the column's default
        // `align-items: stretch`. (WorkspaceRail's rows sit inside a
        // horizontal `ws-row-wrap`, where flex-1 is inert.)
        'ws-row ws-tree-row ws-course flex min-w-0 items-center px-2 text-left',
        active && 'ws-row-active',
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="ws-course-name block truncate text-[13px]">{course.title}</span>
      </span>
      <span className="ws-row-meta shrink-0">
        {course.status === 'published'
          ? t('teacherRail.statusPublished')
          : course.status === 'archived'
            ? t('teacherRail.statusArchived')
            : t('teacherRail.statusDraft')}
        · {course.sceneCount}
      </span>
    </button>
  );
}

/** The workbench rail's pager, verbatim in shape and classes. */
function PagedRows<T>({
  id,
  items,
  initial,
  pages,
  onMore,
  onCollapse,
  render,
}: {
  readonly id: string;
  readonly items: readonly T[];
  readonly initial: number;
  readonly pages: number;
  readonly onMore: () => void;
  readonly onCollapse: () => void;
  readonly render: (item: T) => ReactNode;
}) {
  const { t } = useI18n();
  const { visible, nextCount, canCollapse } = pageList(items, pages, { initial });
  return (
    <>
      {visible.map(render)}
      {nextCount > 0 ? (
        <button
          type="button"
          data-testid={`teacher-rail-show-more-${id}`}
          onClick={onMore}
          className="ws-more flex h-7 w-full items-center px-2 text-left text-[12px]"
        >
          {t('workspace.showMore', { count: nextCount })}
        </button>
      ) : null}
      {canCollapse ? (
        <button
          type="button"
          data-testid={`teacher-rail-show-less-${id}`}
          onClick={onCollapse}
          className="ws-more flex h-7 w-full items-center px-2 text-left text-[12px]"
        >
          {t('workspace.showLess')}
        </button>
      ) : null}
    </>
  );
}
