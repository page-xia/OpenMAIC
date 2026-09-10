'use client';

/**
 * Student home — the published-course library, kept visually identical to the
 * classic OpenMAIC home: the gradient page, floating top-right pill, blurred
 * background orbs, centered hero with the composer-styled assistant chat, and
 * the divider-line collapsible course grid below.
 *
 * The composer keeps the classic input affordances adapted to the assistant:
 * voice input (SpeechButton → server ASR, zero student config) and course-
 * material attachments (document → extracted text → context for the question).
 * Courses come from the teacher backend's published snapshots and the chat
 * answers from the server-configured model — no generation form, no settings,
 * no import on the student side.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'motion/react';
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  FileText,
  ImagePlus,
  Loader2,
  LogOut,
  Paperclip,
  Pencil,
  Search,
  Sparkles,
  Sun,
  Moon,
  Monitor,
  X,
} from 'lucide-react';
import { nanoid } from 'nanoid';
import { toast } from 'sonner';
import { useI18n } from '@/lib/hooks/use-i18n';
import { LanguageSwitcher } from '@/components/language-switcher';
import { SpeechButton } from '@/components/audio/speech-button';
import { Button } from '@/components/ui/button';
import { AgentBar } from '@/components/agent/agent-bar';
import { createLogger } from '@/lib/logger';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { InputGroup, InputGroupInput, InputGroupButton } from '@/components/ui/input-group';
import { Textarea as UITextarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useTheme } from '@/lib/hooks/use-theme';
import { useUserProfileStore, AVATAR_OPTIONS } from '@/lib/store/user-profile';
import {
  MAX_DOCUMENT_BUNDLE_FILES,
  MAX_DOCUMENT_BUNDLE_TOTAL_SIZE_BYTES,
  buildDocumentBundle,
} from '@/lib/document/bundle';
import { SUPPORTED_COURSE_MATERIAL_MIME_TYPES, COURSE_MATERIAL_ACCEPT } from '@/lib/document/mime';

const log = createLogger('StudentHome');

/** Attachment context is capped the same way generation caps PDF content. */
const MAX_ATTACHMENT_CONTEXT_CHARS = 50000;

interface PublishedCourse {
  id: string;
  title: string;
  description: string | null;
  sceneCount: number;
  publishedAt: number;
  version: number;
  /** Course cover image URL; null when the teacher has not set one yet. */
  coverUrl: string | null;
}

interface ChatBubble {
  role: 'user' | 'assistant';
  content: string;
}

interface StudentMe {
  id: string;
  username: string;
  displayName: string;
}

/** A student-picked file plus its extraction state (idle → parsing → ready/failed). */
interface ChatAttachment {
  id: string;
  file: File;
  /** Extracted plain text; empty until `status` is 'ready'. */
  text: string;
  status: 'parsing' | 'ready' | 'failed';
  /** Server explanation for a failed extraction, shown on the chip. */
  error?: string;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString();
}

// ─── Greeting Bar — avatar + "Hi, Name", click to edit in-place ────
const MAX_AVATAR_SIZE = 5 * 1024 * 1024;

function isCustomAvatar(src: string) {
  return src.startsWith('data:');
}

function GreetingBar() {
  const { t } = useI18n();
  const avatar = useUserProfileStore((s) => s.avatar);
  const nickname = useUserProfileStore((s) => s.nickname);
  const bio = useUserProfileStore((s) => s.bio);
  const setAvatar = useUserProfileStore((s) => s.setAvatar);
  const setNickname = useUserProfileStore((s) => s.setNickname);
  const setBio = useUserProfileStore((s) => s.setBio);

  const [open, setOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const displayName = nickname || t('profile.defaultNickname');

  // Click-outside to collapse
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setEditingName(false);
        setAvatarPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const startEditName = () => {
    setNameDraft(nickname);
    setEditingName(true);
    setTimeout(() => nameInputRef.current?.focus(), 50);
  };

  const commitName = () => {
    setNickname(nameDraft.trim());
    setEditingName(false);
  };

  const handleAvatarUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_AVATAR_SIZE) {
      toast.error(t('profile.fileTooLarge'));
      return;
    }
    if (!file.type.startsWith('image/')) {
      toast.error(t('profile.invalidFileType'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new window.Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 128;
        const ctx = canvas.getContext('2d')!;
        const scale = Math.max(128 / img.width, 128 / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, (128 - w) / 2, (128 - h) / 2, w, h);
        setAvatar(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  return (
    <div ref={containerRef} className="relative pl-4 pr-2 pt-3.5 pb-1 w-auto">
      <input
        ref={avatarInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleAvatarUpload}
      />

      {/* ── Collapsed pill (always in flow) ── */}
      {!open && (
        <div
          className="flex items-center gap-2.5 cursor-pointer transition-all duration-200 group rounded-full px-2.5 py-1.5 border border-border/50 text-muted-foreground/70 hover:text-foreground hover:bg-muted/60 active:scale-[0.97]"
          onClick={() => setOpen(true)}
        >
          <div className="shrink-0 relative">
            <div className="size-8 rounded-full overflow-hidden ring-[1.5px] ring-border/30 group-hover:ring-violet-400/60 dark:group-hover:ring-violet-400/40 transition-all duration-300">
              <img src={avatar} alt="" className="size-full object-cover" />
            </div>
            <div className="absolute -bottom-0.5 -right-0.5 size-3.5 rounded-full bg-white dark:bg-slate-800 border border-border/40 flex items-center justify-center opacity-60 group-hover:opacity-100 transition-opacity">
              <Pencil className="size-[7px] text-muted-foreground/70" />
            </div>
          </div>
          <div className="flex-1 min-w-0">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="leading-none select-none flex items-center gap-1">
                  <span className="text-[13px] font-semibold text-foreground/85 group-hover:text-foreground transition-colors">
                    {t('home.greetingWithName', { name: displayName })}
                  </span>
                  <ChevronDown className="size-3 text-muted-foreground/30 group-hover:text-muted-foreground/60 transition-colors shrink-0" />
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}>
                {t('profile.editTooltip')}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      )}

      {/* ── Expanded panel (absolute, floating) ── */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.97 }}
            transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
            className="absolute left-4 top-3.5 z-50 w-64"
          >
            <div className="rounded-2xl bg-white/95 dark:bg-slate-800/95 backdrop-blur-sm ring-1 ring-black/[0.04] dark:ring-white/[0.06] shadow-[0_1px_8px_-2px_rgba(0,0,0,0.06)] dark:shadow-[0_1px_8px_-2px_rgba(0,0,0,0.3)] px-2.5 py-2">
              {/* ── Row: avatar + name ── */}
              <div
                className="flex items-center gap-2.5 cursor-pointer transition-all duration-200"
                onClick={() => {
                  setOpen(false);
                  setEditingName(false);
                  setAvatarPickerOpen(false);
                }}
              >
                {/* Avatar */}
                <div
                  className="shrink-0 relative cursor-pointer"
                  onClick={(e) => {
                    e.stopPropagation();
                    setAvatarPickerOpen(!avatarPickerOpen);
                  }}
                >
                  <div className="size-8 rounded-full overflow-hidden ring-[1.5px] ring-violet-300/70 dark:ring-violet-500/40 transition-all duration-300">
                    <img src={avatar} alt="" className="size-full object-cover" />
                  </div>
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    className="absolute -bottom-0.5 -right-0.5 size-3.5 rounded-full bg-white dark:bg-slate-800 border border-border/60 flex items-center justify-center"
                  >
                    <ChevronDown
                      className={cn(
                        'size-2 text-muted-foreground/70 transition-transform duration-200',
                        avatarPickerOpen && 'rotate-180',
                      )}
                    />
                  </motion.div>
                </div>

                {/* Text */}
                <div className="flex-1 min-w-0">
                  {editingName ? (
                    <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                      <input
                        ref={nameInputRef}
                        value={nameDraft}
                        onChange={(e) => setNameDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitName();
                          if (e.key === 'Escape') {
                            setEditingName(false);
                          }
                        }}
                        onBlur={commitName}
                        maxLength={20}
                        placeholder={t('profile.defaultNickname')}
                        className="flex-1 min-w-0 h-6 bg-transparent border-b border-border/80 text-[13px] font-semibold text-foreground outline-none placeholder:text-muted-foreground/40"
                      />
                      <button
                        onClick={commitName}
                        className="shrink-0 size-5 rounded flex items-center justify-center text-violet-500 hover:bg-violet-100 dark:hover:bg-violet-900/30"
                      >
                        <Check className="size-3" />
                      </button>
                    </div>
                  ) : (
                    <span
                      onClick={(e) => {
                        e.stopPropagation();
                        startEditName();
                      }}
                      className="group/name inline-flex items-center gap-1 cursor-pointer"
                    >
                      <span className="text-[13px] font-semibold text-foreground/85 group-hover/name:text-foreground transition-colors">
                        {displayName}
                      </span>
                      <Pencil className="size-2.5 text-muted-foreground/30 opacity-0 group-hover/name:opacity-100 transition-opacity" />
                    </span>
                  )}
                </div>

                {/* Collapse arrow */}
                <motion.div
                  initial={{ opacity: 0, y: -2 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="shrink-0 size-6 rounded-full flex items-center justify-center hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
                >
                  <ChevronUp className="size-3.5 text-muted-foreground/50" />
                </motion.div>
              </div>

              {/* ── Expandable content ── */}
              <div className="pt-2" onClick={(e) => e.stopPropagation()}>
                {/* Avatar picker */}
                <AnimatePresence>
                  {avatarPickerOpen && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.15, ease: 'easeInOut' }}
                      className="overflow-hidden"
                    >
                      <div className="p-1 pb-2.5 flex items-center gap-1.5 flex-wrap">
                        {AVATAR_OPTIONS.map((url) => (
                          <button
                            key={url}
                            onClick={() => setAvatar(url)}
                            className={cn(
                              'size-7 rounded-full overflow-hidden bg-gray-50 dark:bg-gray-800 cursor-pointer transition-all duration-150',
                              'hover:scale-110 active:scale-95',
                              avatar === url
                                ? 'ring-2 ring-violet-400 dark:ring-violet-500 ring-offset-0'
                                : 'hover:ring-1 hover:ring-muted-foreground/30',
                            )}
                          >
                            <img src={url} alt="" className="size-full" />
                          </button>
                        ))}
                        <label
                          className={cn(
                            'size-7 rounded-full flex items-center justify-center cursor-pointer transition-all duration-150 border border-dashed',
                            'hover:scale-110 active:scale-95',
                            isCustomAvatar(avatar)
                              ? 'ring-2 ring-violet-400 dark:ring-violet-500 ring-offset-0 border-violet-300 dark:border-violet-600 bg-violet-50 dark:bg-violet-900/30'
                              : 'border-muted-foreground/30 text-muted-foreground/50 hover:border-muted-foreground/50',
                          )}
                          onClick={() => avatarInputRef.current?.click()}
                          title={t('profile.uploadAvatar')}
                        >
                          <ImagePlus className="size-3" />
                        </label>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Bio */}
                <UITextarea
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  placeholder={t('profile.bioPlaceholder')}
                  maxLength={200}
                  rows={2}
                  className="resize-none border-border/40 bg-transparent min-h-[72px] !text-[13px] !leading-relaxed placeholder:!text-[11px] placeholder:!leading-relaxed focus-visible:ring-1 focus-visible:ring-border/60"
                />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function StudentHomePage() {
  const { t } = useI18n();
  const { theme, setTheme } = useTheme();
  const router = useRouter();
  const [themeOpen, setThemeOpen] = useState(false);

  // ── Courses (published snapshots from the teacher backend) ──
  const [courses, setCourses] = useState<PublishedCourse[] | null>(null);
  const [recentOpen, setRecentOpen] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);

  // ── Student session (login state in the top-right pill) ──
  const [student, setStudent] = useState<StudentMe | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/student/auth/me')
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { student?: StudentMe | null } | null) => {
        if (!cancelled) setStudent(body?.student ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const handleStudentLogout = useCallback(async () => {
    await fetch('/api/student/auth/logout', { method: 'POST' }).catch(() => undefined);
    setStudent(null);
  }, []);

  // ── Point-of-use login prompt ──
  // Anonymous visitors may browse the catalog, but using a feature (asking the
  // assistant, opening a classroom) asks them to sign in first — the invite-
  // code account system replaced the retired global ACCESS_CODE gate.
  const [loginPromptOpen, setLoginPromptOpen] = useState(false);
  const [loginPromptNext, setLoginPromptNext] = useState('/login');
  const requireLogin = useCallback((next?: string) => {
    setLoginPromptNext(next ? `/login?next=${encodeURIComponent(next)}` : '/login');
    setLoginPromptOpen(true);
  }, []);
  const openCourse = useCallback(
    (courseId: string) => {
      if (!student) {
        requireLogin(`/classroom/${courseId}`);
        return;
      }
      router.push(`/classroom/${courseId}`);
    },
    [student, requireLogin, router],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/student/courses');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json()) as { success: boolean; courses?: PublishedCourse[] };
        if (!cancelled && body.success) setCourses(body.courses ?? []);
      } catch (error) {
        log.warn('Course library load failed:', error);
        if (!cancelled) setCourses([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const isSearching = searchQuery.trim() !== '';
  const visibleCourses = useMemo(() => {
    const list = courses ?? [];
    if (!isSearching) return list;
    const q = searchQuery.trim().toLowerCase();
    return list.filter((course) => course.title.toLowerCase().includes(q));
  }, [courses, isSearching, searchQuery]);

  // ── Assistant chat (composer card in the hero, original styling) ──
  const [chatMessages, setChatMessages] = useState<ChatBubble[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatStreaming, setChatStreaming] = useState(false);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);

  const addAttachmentFiles = useCallback((files: File[]) => {
    setAttachments((prev) => {
      if (prev.length >= MAX_DOCUMENT_BUNDLE_FILES) return prev;
      const totalBytes =
        prev.reduce((sum, item) => sum + item.file.size, 0) +
        files.reduce((sum, file) => sum + file.size, 0);
      if (totalBytes > MAX_DOCUMENT_BUNDLE_TOTAL_SIZE_BYTES) return prev;
      const existing = new Set(prev.map((item) => `${item.file.name}:${item.file.size}`));
      const room = MAX_DOCUMENT_BUNDLE_FILES - prev.length;
      return [
        ...prev,
        ...files
          .filter(
            (file) =>
              !existing.has(`${file.name}:${file.size}`) &&
              (SUPPORTED_COURSE_MATERIAL_MIME_TYPES.includes(file.type) ||
                COURSE_MATERIAL_ACCEPT.includes(file.name.slice(file.name.lastIndexOf('.')))),
          )
          .slice(0, room)
          .map((file) => ({ id: nanoid(8), file, text: '', status: 'parsing' as const })),
      ];
    });
  }, []);

  // Extract each freshly-added attachment server-side (keyless extractors —
  // plain text / unpdf — work with zero student configuration; the server
  // resolves operator-configured providers where applicable).
  useEffect(() => {
    const pending = attachments.filter((item) => item.status === 'parsing');
    if (pending.length === 0) return;
    let cancelled = false;
    for (const item of pending) {
      void (async () => {
        let failureReason = '';
        try {
          const formData = new FormData();
          formData.append('file', item.file);
          const response = await fetch('/api/extract-document', {
            method: 'POST',
            body: formData,
          });
          const body = (await response.json().catch(() => null)) as {
            success?: boolean;
            error?: string;
            data?: { text?: string };
          } | null;
          if (cancelled) return;
          if (!body?.success) {
            failureReason = body?.error ?? '';
          } else {
            const text = body.data?.text ?? '';
            if (text.trim()) {
              setAttachments((prev) =>
                prev.map((entry) =>
                  entry.id === item.id ? { ...entry, text, status: 'ready' } : entry,
                ),
              );
              return;
            }
          }
        } catch {
          // network failure — fall through to the failed state below
        }
        if (!cancelled) {
          setAttachments((prev) =>
            prev.map((entry) =>
              entry.id === item.id ? { ...entry, status: 'failed', error: failureReason } : entry,
            ),
          );
        }
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [attachments]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const sendChat = useCallback(async () => {
    const text = chatInput.trim();
    if ((!text && attachments.length === 0) || chatStreaming) return;
    // Using the assistant is a sign-in moment for anonymous visitors.
    if (!student) {
      requireLogin();
      return;
    }
    const readyAttachments = attachments.filter((item) => item.status === 'ready');
    setChatInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    setChatStreaming(true);
    const history = chatMessages.map(({ role, content }) => ({ role, content }));

    // Attachments ride as a framed context block ahead of the question, the
    // same shape the generation pipeline builds from course materials.
    const attachmentContext =
      readyAttachments.length > 0
        ? buildDocumentBundle(
            readyAttachments.map((item, index) => ({
              source: {
                id: item.id,
                name: item.file.name,
                size: item.file.size,
                lastModified: item.file.lastModified,
                mimeType: item.file.type,
                order: index + 1,
              },
              text: item.text,
              rawTextLength: item.text.length,
              images: [],
            })),
            { maxChars: MAX_ATTACHMENT_CONTEXT_CHARS },
          ).text
        : '';
    const userContent =
      attachmentContext.trim() !== ''
        ? `${text || t('studentHome.attachmentOnly')}\n\n${attachmentContext}`
        : text;

    setChatMessages((prev) => [
      ...prev,
      // The visible bubble keeps just the typed text (plus an attachment note)
      // so the transcript stays readable; the full context goes to the server.
      {
        role: 'user',
        content:
          readyAttachments.length > 0
            ? `${text}\n[${t('studentHome.attachmentContext', {
                n: readyAttachments.length,
              })}]`
            : text,
      },
      { role: 'assistant', content: '' },
    ]);
    setAttachments([]);
    try {
      const response = await fetch('/api/student/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [...history, { role: 'user', content: userContent }],
        }),
      });
      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        const reason = body?.error ?? '聊天服务暂时不可用';
        setChatMessages((prev) => {
          const next = [...prev];
          next[next.length - 1] = { role: 'assistant', content: reason };
          return next;
        });
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (chunk === '') continue;
        setChatMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1]!;
          next[next.length - 1] = { role: 'assistant', content: last.content + chunk };
          return next;
        });
      }
    } catch {
      setChatMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1]!;
        if (last.role === 'assistant' && last.content === '') {
          next[next.length - 1] = { role: 'assistant', content: '网络错误，请稍后重试。' };
        }
        return next;
      });
    } finally {
      setChatStreaming(false);
    }
  }, [chatInput, chatMessages, chatStreaming, attachments, t, student, requireLogin]);

  const parsingCount = attachments.filter((item) => item.status === 'parsing').length;
  const readyCount = attachments.filter((item) => item.status === 'ready').length;
  const canChat =
    (chatInput.trim() !== '' || readyCount > 0) && !chatStreaming && parsingCount === 0;

  return (
    <div className="min-h-[100dvh] w-full bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900 flex flex-col items-center p-4 pt-16 md:p-8 md:pt-16 overflow-x-hidden">
      {/* ═══ Top-right pill (original styling) ═══ */}
      <div className="fixed top-4 right-4 z-50 flex items-center gap-1 bg-white/60 dark:bg-gray-800/60 backdrop-blur-md px-2 py-1.5 rounded-full border border-gray-100/50 dark:border-gray-700/50 shadow-sm">
        {/* Student session — login entry when anonymous, name + logout when in */}
        {student ? (
          <>
            <span
              className="max-w-[120px] truncate px-1 text-xs font-medium text-gray-600 dark:text-gray-300"
              title={student.displayName}
            >
              {student.displayName}
            </span>
            <button
              onClick={() => void handleStudentLogout()}
              className="p-2 rounded-full text-gray-400 dark:text-gray-500 hover:bg-white dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-gray-200 hover:shadow-sm transition-all"
              aria-label="退出登录"
              title="退出登录"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </>
        ) : (
          <button
            onClick={() => router.push('/login')}
            className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            登录 / 注册
          </button>
        )}

        <div className="w-[1px] h-4 bg-gray-200 dark:bg-gray-700" />

        <LanguageSwitcher onOpen={() => setThemeOpen(false)} />

        <div className="w-[1px] h-4 bg-gray-200 dark:bg-gray-700" />

        <div className="relative">
          <button
            onClick={() => setThemeOpen(!themeOpen)}
            className="p-2 rounded-full text-gray-400 dark:text-gray-500 hover:bg-white dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-gray-200 hover:shadow-sm transition-all"
            aria-label={t('settings.theme')}
          >
            {theme === 'light' && <Sun className="w-4 h-4" />}
            {theme === 'dark' && <Moon className="w-4 h-4" />}
            {theme === 'system' && <Monitor className="w-4 h-4" />}
          </button>
          {themeOpen && (
            <div className="absolute top-full mt-2 right-0 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg overflow-hidden z-50 min-w-[140px]">
              {(['light', 'dark', 'system'] as const).map((mode) => {
                const Icon = mode === 'light' ? Sun : mode === 'dark' ? Moon : Monitor;
                return (
                  <button
                    key={mode}
                    onClick={() => {
                      setTheme(mode);
                      setThemeOpen(false);
                    }}
                    className={cn(
                      'w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors flex items-center gap-2',
                      theme === mode &&
                        'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400',
                    )}
                  >
                    <Icon className="w-4 h-4" />
                    {t(`settings.themeOptions.${mode}`)}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ═══ Point-of-use login prompt ═══ */}
      <Dialog open={loginPromptOpen} onOpenChange={setLoginPromptOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>请先登录</DialogTitle>
            <DialogDescription>
              使用课程学习和 AI 助教需要学生账号。还没有账号？在登录页用邀请码注册。
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setLoginPromptOpen(false)}>
              逛一逛
            </Button>
            <Button
              onClick={() => {
                setLoginPromptOpen(false);
                router.push(loginPromptNext);
              }}
            >
              去登录 / 注册
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ═══ Background Decor (original) ═══ */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div
          className="absolute top-0 left-1/4 w-96 h-96 bg-blue-500/10 rounded-full blur-3xl animate-pulse"
          style={{ animationDuration: '4s' }}
        />
        <div
          className="absolute bottom-0 right-1/4 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl animate-pulse"
          style={{ animationDuration: '6s' }}
        />
      </div>

      {/* ═══ Hero: logo + slogan + assistant composer ═══ */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: 'easeOut' }}
        className="relative z-20 w-full max-w-[800px] flex flex-col items-center mt-[10vh]"
      >
        <motion.img
          src="/logo-horizontal.png"
          alt="OpenMAIC"
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.1, type: 'spring', stiffness: 200, damping: 20 }}
          className="h-12 md:h-16 mb-2 -ml-2 md:-ml-3"
        />

        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.25 }}
          className="text-sm text-muted-foreground/60 mb-8"
        >
          {t('studentHome.slogan')}
        </motion.p>

        {/* ── Assistant chat in the original composer card ── */}
        <motion.div
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.35 }}
          className="w-full"
        >
          <div className="w-full rounded-2xl border border-border/60 bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl shadow-xl shadow-black/[0.03] dark:shadow-black/20 transition-shadow focus-within:shadow-2xl focus-within:shadow-violet-500/[0.06]">
            {/* Header row: greeting/profile (original) + classroom agents (original) */}
            <div className="relative z-20 flex items-start justify-between">
              <GreetingBar />
              <div className="pr-3 pt-3.5 shrink-0">
                <AgentBar />
              </div>
            </div>

            {/* Conversation area (grows with messages, scrolls) */}
            {chatMessages.length > 0 ? (
              <div className="max-h-[320px] overflow-y-auto px-4 pb-1 space-y-2.5">
                {chatMessages.map((message, index) => (
                  <div
                    key={index}
                    className={cn(
                      'text-[13px] leading-relaxed whitespace-pre-wrap rounded-xl px-3 py-2',
                      message.role === 'user'
                        ? 'ml-auto max-w-[85%] bg-violet-500/10 text-foreground/90'
                        : 'mr-auto max-w-[95%] bg-muted/60 text-foreground/80',
                    )}
                  >
                    {message.content ||
                      (chatStreaming && index === chatMessages.length - 1 ? '…' : '')}
                  </div>
                ))}
              </div>
            ) : null}

            {/* Attachment chips (original course-material metrics) */}
            {attachments.length > 0 ? (
              <div className="px-4 pb-1 space-y-2">
                {attachments.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center gap-2 rounded-lg border border-border/50 px-2 py-2"
                  >
                    <div className="size-8 rounded-lg bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center shrink-0">
                      <FileText className="size-4 text-violet-600 dark:text-violet-400" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{item.file.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {item.status === 'parsing' && t('studentHome.attachmentParsing')}
                        {item.status === 'ready' &&
                          `${(item.file.size / 1024 / 1024).toFixed(2)} MB`}
                        {item.status === 'failed' &&
                          (item.error?.trim()
                            ? `${t('studentHome.attachmentFailed')}：${item.error}`
                            : t('studentHome.attachmentFailed'))}
                      </p>
                    </div>
                    {item.status === 'parsing' ? (
                      <Loader2 className="size-4 animate-spin text-muted-foreground/60 shrink-0" />
                    ) : (
                      <button
                        onClick={() => removeAttachment(item.id)}
                        className="size-6 rounded-full inline-flex items-center justify-center text-muted-foreground transition-colors hover:bg-muted cursor-pointer"
                        aria-label={t('studentHome.removeAttachment')}
                      >
                        <X className="size-3.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            ) : null}

            {/* Textarea — same metrics as the original requirement composer */}
            <textarea
              ref={textareaRef}
              placeholder={t('studentHome.askPlaceholder')}
              className="w-full resize-none border-0 bg-transparent px-4 pt-2 pb-2 text-[13px] leading-relaxed placeholder:text-muted-foreground/40 focus:outline-none min-h-[72px] max-h-[200px]"
              value={chatInput}
              onChange={(e) => {
                setChatInput(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void sendChat();
                }
              }}
              rows={3}
            />

            {/* Toolbar row — attachments + voice + send, like the original */}
            <div className="px-3 pb-3 flex items-end gap-2">
              <input
                type="file"
                ref={attachmentInputRef}
                className="hidden"
                accept={COURSE_MATERIAL_ACCEPT}
                multiple
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  if (files.length > 0) addAttachmentFiles(files);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                onClick={() => attachmentInputRef.current?.click()}
                disabled={chatStreaming}
                className={cn(
                  'shrink-0 h-8 rounded-lg flex items-center justify-center gap-1.5 transition-all px-3 text-xs font-medium',
                  attachments.length > 0
                    ? 'bg-violet-500/10 text-violet-600 dark:text-violet-300'
                    : 'bg-muted text-muted-foreground/70 hover:text-foreground/90 cursor-pointer',
                  chatStreaming && 'cursor-not-allowed opacity-50',
                )}
                aria-label={t('studentHome.addAttachment')}
              >
                <Paperclip className="size-3.5" />
                {attachments.length > 0 && <span>{attachments.length}</span>}
              </button>

              <div className="flex-1" />

              {/* Voice input — the original SpeechButton, gated by server ASR */}
              <SpeechButton
                size="md"
                disabled={chatStreaming}
                onTranscription={(text) => {
                  setChatInput((prev) => prev + (prev ? ' ' : '') + text);
                }}
              />

              {/* Send button */}
              <button
                onClick={() => void sendChat()}
                disabled={!canChat}
                className={cn(
                  'shrink-0 h-8 rounded-lg flex items-center justify-center gap-1.5 transition-all px-3',
                  canChat
                    ? 'bg-primary text-primary-foreground hover:opacity-90 shadow-sm cursor-pointer'
                    : 'bg-muted text-muted-foreground/40 cursor-not-allowed',
                )}
              >
                <span className="text-xs font-medium">
                  {chatStreaming ? t('studentHome.thinking') : t('studentHome.ask')}
                </span>
                {chatStreaming ? (
                  <motion.span
                    animate={{ rotate: 360 }}
                    transition={{ repeat: Infinity, duration: 0.8, ease: 'linear' }}
                    className="size-3.5 rounded-full border-[1.5px] border-current border-t-transparent"
                  />
                ) : (
                  <ArrowUp className="size-3.5" />
                )}
              </button>
            </div>
          </div>
        </motion.div>
      </motion.div>

      {/* ═══ Course library — divider-line header + collapsible grid (original) ═══ */}
      {courses !== null && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5 }}
          className="relative z-10 mt-10 w-full max-w-6xl flex flex-col items-center"
        >
          <div className="group w-full flex items-center gap-4 h-9">
            <div className="flex-1 h-px bg-border/40 group-hover:bg-border/70 transition-colors" />
            <div className="shrink-0 flex items-center gap-3 text-[13px] text-muted-foreground/60 select-none">
              <button
                onClick={() => setRecentOpen(!recentOpen)}
                className="flex items-center gap-2 hover:text-foreground/70 transition-colors cursor-pointer"
              >
                <Clock className="size-3.5" />
                {t('studentHome.library')}
                <span className="text-[11px] tabular-nums opacity-60">{courses.length}</span>
                <motion.div
                  animate={{ rotate: recentOpen ? 180 : 0 }}
                  transition={{ duration: 0.3, ease: 'easeInOut' }}
                >
                  <ChevronDown className="size-3.5" />
                </motion.div>
              </button>

              {/* Search toggle — icon that expands into an input in place */}
              <AnimatePresence initial={false}>
                {!searchOpen ? (
                  <motion.button
                    key="search-icon"
                    ref={searchButtonRef}
                    type="button"
                    aria-label={t('classroom.searchAriaLabel')}
                    onClick={() => {
                      setSearchOpen(true);
                      setRecentOpen(true);
                      requestAnimationFrame(() => searchInputRef.current?.focus());
                    }}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.12, ease: 'easeOut' }}
                    className="flex items-center justify-center size-6 rounded-full text-muted-foreground/50 hover:text-foreground/70 hover:bg-muted/50 transition-colors cursor-pointer"
                  >
                    <Search className="size-3.5" />
                  </motion.button>
                ) : (
                  <motion.div
                    key="search-input"
                    initial={{ opacity: 0, width: 0 }}
                    animate={{ opacity: 1, width: 200 }}
                    exit={{ opacity: 0, width: 0 }}
                    transition={{ duration: 0.18, ease: [0.25, 0.1, 0.25, 1] }}
                    className="overflow-hidden"
                  >
                    <InputGroup className="h-7 text-[12px] rounded-full bg-muted/40 border-transparent shadow-none transition-colors hover:bg-muted/60">
                      <InputGroupInput
                        ref={searchInputRef}
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            e.preventDefault();
                            if (searchQuery) setSearchQuery('');
                            else {
                              setSearchOpen(false);
                              requestAnimationFrame(() => searchButtonRef.current?.focus());
                            }
                          }
                        }}
                        onBlur={() => {
                          if (!searchQuery) setSearchOpen(false);
                        }}
                        placeholder={t('classroom.searchPlaceholder')}
                        aria-label={t('classroom.searchAriaLabel')}
                        className="h-7 pl-3 placeholder:text-muted-foreground/50"
                      />
                      {searchQuery && (
                        <InputGroupButton
                          size="icon-xs"
                          aria-label={t('classroom.clearSearch')}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            setSearchQuery('');
                            searchInputRef.current?.focus();
                          }}
                        >
                          <X />
                        </InputGroupButton>
                      )}
                    </InputGroup>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            <div className="flex-1 h-px bg-border/40 group-hover:bg-border/70 transition-colors" />
          </div>

          {/* Expandable content */}
          <AnimatePresence>
            {recentOpen && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
                className="w-full overflow-hidden"
              >
                {courses.length === 0 ? (
                  <div className="pt-8 pb-2 text-center text-[13px] text-muted-foreground/60">
                    {t('studentHome.emptyLibrary')}
                  </div>
                ) : isSearching && visibleCourses.length === 0 ? (
                  <div className="pt-8 pb-2 text-center text-[13px] text-muted-foreground/60">
                    {t('classroom.searchEmpty')}
                  </div>
                ) : (
                  <div className="pt-8">
                    <AnimatePresence mode="wait">
                      <motion.div
                        key={isSearching ? 'search' : 'root'}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -8 }}
                        transition={{ duration: 0.2 }}
                        className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-5 gap-y-8"
                      >
                        {visibleCourses.map((course, i) => (
                          <motion.div
                            key={course.id}
                            initial={{ opacity: 0, y: 16 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: i * 0.04, duration: 0.35, ease: 'easeOut' }}
                          >
                            <div
                              className="group cursor-pointer"
                              onClick={() => openCourse(course.id)}
                            >
                              {/* Thumbnail — the course cover (the deck's first page by
                                  default, or the image the teacher uploaded), with a
                                  gradient placeholder until a cover exists. */}
                              <div className="relative w-full aspect-[16/9] rounded-2xl bg-slate-100 dark:bg-slate-800/80 overflow-hidden transition-transform duration-200 group-hover:scale-[1.02]">
                                {course.coverUrl ? (
                                  <img
                                    src={course.coverUrl}
                                    alt=""
                                    loading="lazy"
                                    draggable={false}
                                    className="absolute inset-0 size-full object-cover"
                                  />
                                ) : (
                                  <div className="absolute inset-0 flex items-center justify-center">
                                    <div className="size-12 rounded-2xl bg-gradient-to-br from-violet-100 to-blue-100 dark:from-violet-900/30 dark:to-blue-900/30 flex items-center justify-center">
                                      <span className="text-xl opacity-50">📄</span>
                                    </div>
                                  </div>
                                )}
                                <span className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-full bg-white/70 dark:bg-slate-900/60 px-2 py-0.5 text-[10px] font-medium text-violet-600 dark:text-violet-300 backdrop-blur-sm shadow-sm">
                                  <Sparkles className="size-2.5" />v{course.version}
                                </span>
                              </div>

                              {/* Info — outside the thumbnail, original metrics */}
                              <div className="mt-2.5 px-1 flex items-center gap-2">
                                <span className="shrink-0 inline-flex items-center rounded-full bg-violet-100 dark:bg-violet-900/30 px-2 py-0.5 text-[11px] font-medium text-violet-600 dark:text-violet-400">
                                  {course.sceneCount} {t('classroom.slides')} ·{' '}
                                  {formatDate(course.publishedAt)}
                                </span>
                                <p className="font-medium text-[15px] truncate text-foreground/90 min-w-0">
                                  {course.title}
                                </p>
                              </div>
                            </div>
                          </motion.div>
                        ))}
                      </motion.div>
                    </AnimatePresence>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </div>
  );
}
