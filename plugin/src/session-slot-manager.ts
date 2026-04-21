/**
 * SessionSlotManager — central state machine for v4 dynamic session-per-button layout.
 *
 * Two views:
 * - List View: each button shows one session (OC first, then CC by startedAt)
 * - Detail View: button 1=BACK, button 2=session info, buttons 3-7=options, button 8=ESC/STOP
 */
import type { SessionInfo } from '@agentdeck/shared';
import { State, sortSessions, assignDisplayNames } from '@agentdeck/shared';
import type { PromptOption, AgentType } from '@agentdeck/shared';
import { dlog } from './log.js';

export type SlotView = 'list' | 'detail';

export interface PresetAction {
  label: string;
  iconSvg: string;        // SVG elements for the icon area (centered at 72,44 in 144x144 canvas)
  color: string;
  textColor: string;
  subtitle?: string;       // secondary text below label (e.g. model name)
  prompt?: string;         // send_prompt text
  localAction?: string;    // local action: 'open_gateway', 'switch_model'
  loading?: boolean;       // show loading indicator
}

export interface SessionSlotConfig {
  type: 'session' | 'back' | 'info' | 'option' | 'esc' | 'stop' | 'next-page' | 'preset' | 'empty';
  session?: SessionInfo;
  option?: PromptOption;
  optionIndex?: number;
  label?: string;
  preset?: PresetAction;
  /** For list view: is this the currently "active" (connected) session? */
  isActive?: boolean;
}

// ---- OpenClaw preset SVG icons (144x144 button canvas) ----

const SUMMARIZE_ICON_SVG = [
  `<rect x="40" y="14" width="64" height="56" rx="5" fill="none" stroke="#93c5fd" stroke-width="2"/>`,
  `<line x1="50" y1="28" x2="94" y2="28" stroke="#93c5fd" stroke-width="2" opacity="0.6"/>`,
  `<line x1="50" y1="40" x2="88" y2="40" stroke="#93c5fd" stroke-width="2" opacity="0.6"/>`,
  `<line x1="50" y1="52" x2="78" y2="52" stroke="#93c5fd" stroke-width="2" opacity="0.6"/>`,
  `<polyline points="82,50 87,56 96,44" fill="none" stroke="#93c5fd" stroke-width="2.5" stroke-linecap="round"/>`,
].join('');

// MODEL icon: model name large + swap indicator. loading=true shows spinner animation.
function buildModelIcon(modelName?: string, loading?: boolean): string {
  if (loading) {
    // Spinning arrow animation
    return [
      `<text x="72" y="52" text-anchor="middle" font-family="Arial,sans-serif" font-size="13" fill="#e9d5ff" opacity="0.6">Switching...</text>`,
      `<circle cx="72" cy="72" r="16" fill="none" stroke="#e9d5ff" stroke-width="2.5" stroke-dasharray="80" stroke-dashoffset="20" opacity="0.7"/>`,
    ].join('');
  }
  const display = modelName ? truncateStr(modelName, 14) : 'Model';
  const fontSize = display.length > 10 ? 14 : display.length > 7 ? 17 : 20;
  return [
    // Swap icon (small, top)
    `<path d="M56,24 L48,24 L53,19" fill="none" stroke="#e9d5ff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.5"/>`,
    `<path d="M88,24 L96,24 L91,29" fill="none" stroke="#e9d5ff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.5"/>`,
    `<line x1="48" y1="24" x2="96" y2="24" stroke="#e9d5ff" stroke-width="1" opacity="0.25"/>`,
    // Model name (centered, prominent)
    `<text x="72" y="${58 + (fontSize < 17 ? 2 : 0)}" text-anchor="middle" font-family="Arial,sans-serif" font-size="${fontSize}" font-weight="bold" fill="#e9d5ff">${escapeXml(display)}</text>`,
  ].join('');
}

function truncateStr(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '\u2026';
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

import { OC_BODY, OC_CLAW_L, OC_CLAW_R } from './renderers/agent-logos.js';

const GATEWAY_ICON_SVG = [
  `<rect x="30" y="16" width="84" height="64" rx="6" fill="none" stroke="#94a3b8" stroke-width="2"/>`,
  `<line x1="30" y1="30" x2="114" y2="30" stroke="#94a3b8" stroke-width="1.5"/>`,
  `<circle cx="40" cy="23" r="2.5" fill="#ef4444"/>`,
  `<circle cx="48" cy="23" r="2.5" fill="#fbbf24"/>`,
  `<circle cx="56" cy="23" r="2.5" fill="#4ade80"/>`,
  `<g transform="translate(51,32) scale(0.35)">`,
  `<defs><linearGradient id="oc-btn-g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ff4d4d"/><stop offset="100%" stop-color="#991b1b"/></linearGradient></defs>`,
  `<path d="${OC_BODY}" fill="url(#oc-btn-g)"/>`,
  `<path d="${OC_CLAW_L}" fill="url(#oc-btn-g)"/>`,
  `<path d="${OC_CLAW_R}" fill="url(#oc-btn-g)"/>`,
  `<circle cx="45" cy="35" r="6" fill="#050810"/>`,
  `<circle cx="75" cy="35" r="6" fill="#050810"/>`,
  `</g>`,
].join('');

// OpenClaw preset definitions (iconSvg + action)
// MODEL iconSvg is built dynamically with current model name
const OC_PRESET_DEFS: Array<Omit<PresetAction, 'iconSvg'> & { iconSvg?: string; dynamicIcon?: 'model' }> = [
  { label: 'STATUS', iconSvg: SUMMARIZE_ICON_SVG, color: '#1a1a3e', textColor: '#93c5fd', prompt: 'status' },
  { label: 'MODEL', dynamicIcon: 'model', color: '#2d1f3d', textColor: '#e9d5ff', localAction: 'switch_model' },
  { label: 'GATEWAY', iconSvg: GATEWAY_ICON_SVG, color: '#1a0f2e', textColor: '#c084fc', localAction: 'open_gateway' },
];

// Claude Code quick actions (IDLE detail view)
const GO_ON_ICON_SVG = `<polygon points="60,20 100,44 60,68" fill="#22c55e" opacity="0.8"/>`;
const REVIEW_ICON_SVG = `<rect x="42" y="18" width="60" height="48" rx="4" fill="none" stroke="#93c5fd" stroke-width="2"/><path d="M52,34 h40 M52,46 h32 M52,58 h24" stroke="#93c5fd" stroke-width="1.5" opacity="0.6"/>`;
const COMMIT_ICON_SVG = `<circle cx="72" cy="40" r="20" fill="none" stroke="#22c55e" stroke-width="2"/><polyline points="62,40 70,48 84,32" fill="none" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round"/>`;
const CLEAR_ICON_SVG = `<line x1="52" y1="24" x2="92" y2="64" stroke="#94a3b8" stroke-width="2.5" stroke-linecap="round"/><line x1="92" y1="24" x2="52" y2="64" stroke="#94a3b8" stroke-width="2.5" stroke-linecap="round"/>`;

const CC_PRESET_DEFS: Array<Omit<PresetAction, 'iconSvg'> & { iconSvg?: string; dynamicIcon?: 'model' }> = [
  { label: 'GO ON', iconSvg: GO_ON_ICON_SVG, color: '#1e3a2f', textColor: '#22c55e', prompt: 'go on' },
  { label: 'REVIEW', iconSvg: REVIEW_ICON_SVG, color: '#1e293b', textColor: '#93c5fd', prompt: '/review' },
  { label: 'COMMIT', iconSvg: COMMIT_ICON_SVG, color: '#1e293b', textColor: '#22c55e', prompt: '/commit' },
  { label: 'CLEAR', iconSvg: CLEAR_ICON_SVG, color: '#1e293b', textColor: '#94a3b8', prompt: '/clear' },
];

const SLOTS_PER_PAGE = 7; // When paginating: 7 sessions + 1 nav
const MAX_SESSIONS = 20;
const MAX_SLOTS = 8;

export class SessionSlotManager {
  private static readonly DETAIL_OPTIONS_PER_PAGE = 4;
  private static readonly MODEL_SWITCH_TIMEOUT_MS = 12000;

  private _view: SlotView = 'list';
  private _currentPage = 0;
  private _detailPage = 0;
  private _sessions: SessionInfo[] = [];
  private _displayNames = new Map<string, string>();
  private _focusedSessionId: string | null = null;
  private _activeSessionId: string | null = null;
  private _activeSessionPort: number | null = null;
  private _gatewayAvailable = false;

  // Detail view state (from the focused session's bridge)
  private _detailState = State.DISCONNECTED;
  private _detailOptions: PromptOption[] = [];
  private _detailTool: string | undefined;
  private _detailToolInput: string | undefined;
  private _detailQuestion: string | undefined;
  private _detailModelName: string | undefined;
  private _detailEffortLevel: string | undefined;
  private _detailMode: string | undefined;
  private _modelSwitching = false;
  private _prevModelName: string | undefined;
  private _modelSwitchStartedAt = 0;

  get view(): SlotView { return this._view; }
  get currentPage(): number { return this._currentPage; }
  get focusedSessionId(): string | null { return this._focusedSessionId; }
  get sessions(): SessionInfo[] { return this._sessions; }

  /** Get display name for a session (with #N suffix if needed). Never mutates the original. */
  displayNameFor(session: SessionInfo): string {
    return this._displayNames.get(session.id) ?? session.projectName;
  }
  get detailState(): State { return this._detailState; }
  get detailOptions(): PromptOption[] { return this._detailOptions; }
  get detailModelName(): string | undefined { return this._detailModelName; }
  get detailEffortLevel(): string | undefined { return this._detailEffortLevel; }
  get modelSwitching(): boolean { return this._modelSwitching; }

  startModelSwitch(): void {
    this._prevModelName = this._detailModelName;
    this._modelSwitching = true;
    this._modelSwitchStartedAt = Date.now();
  }

  /** Called when model name changes after switch — auto-detects completion */
  private checkModelSwitchDone(): void {
    if (!this._modelSwitching) return;
    const timedOut = Date.now() - this._modelSwitchStartedAt >= SessionSlotManager.MODEL_SWITCH_TIMEOUT_MS;
    const enteredInteractiveModelPicker =
      this._detailState === State.AWAITING_OPTION
      || this._detailState === State.AWAITING_PERMISSION
      || this._detailState === State.AWAITING_DIFF;
    const leftIdle = this._detailState !== State.IDLE;

    if (timedOut || enteredInteractiveModelPicker || leftIdle) {
      this._modelSwitching = false;
      this._prevModelName = undefined;
      this._modelSwitchStartedAt = 0;
      return;
    }
    if (this._modelSwitching && this._detailModelName && this._detailModelName !== this._prevModelName) {
      this._modelSwitching = false;
      this._prevModelName = undefined;
      this._modelSwitchStartedAt = 0;
    }
  }

  // ---- Session list updates ----

  updateSessions(sessions: SessionInfo[], gatewayAvailable: boolean): void {
    this._gatewayAvailable = gatewayAvailable;
    // Build ordered list: sorted by agentType (openclaw→claude→codex→opencode) then name→startedAt
    const alive = sessions.filter(s => (s.agentType as string) !== 'daemon' && s.alive);

    // OpenClaw virtual sessions are injected by the daemon only after
    // Gateway authentication succeeds. Reachability alone stays a topology
    // signal so the plugin does not create an actionable OpenClaw slot for an
    // unapproved or token-mismatched Gateway.

    // Canonical stable sort: agentType rank → projectName → startedAt → id
    this._sessions = sortSessions(alive).slice(0, MAX_SESSIONS);

    // Assign #N display names for duplicate (projectName, agentType) pairs — no mutation
    this._displayNames = new Map();
    const displayed = assignDisplayNames(this._sessions);
    for (const d of displayed) {
      this._displayNames.set(d.session.id, d.displayName);
    }

    // Clamp page
    const totalPages = this.totalPages();
    if (this._currentPage >= totalPages) {
      this._currentPage = Math.max(0, totalPages - 1);
    }

    dlog('SlotMgr', `updateSessions: ${this._sessions.length} sessions, page=${this._currentPage}, view=${this._view}`);
  }

  setActiveSession(sessionId: string | null, port: number | null): void {
    this._activeSessionId = sessionId;
    this._activeSessionPort = port;
  }

  setGatewayAvailable(available: boolean): void {
    this._gatewayAvailable = available;
  }

  // ---- Detail view state updates ----

  updateDetailState(state: State, options: PromptOption[], tool?: string, toolInput?: string, question?: string, modelName?: string, mode?: string, effortLevel?: string): void {
    this._detailState = state;
    this._detailOptions = options;
    this._detailTool = tool;
    this._detailToolInput = toolInput;
    this._detailQuestion = question;
    this._detailModelName = modelName;
    this._detailEffortLevel = effortLevel;
    this._detailMode = mode;
    if (!this.isAwaitingDetailState()) {
      this._detailPage = 0;
    } else {
      this._detailPage = Math.min(this._detailPage, Math.max(0, this.detailOptionPages() - 1));
    }
    this.checkModelSwitchDone();
  }

  // ---- View transitions ----

  enterDetailView(sessionId: string): void {
    this._focusedSessionId = sessionId;
    this._view = 'detail';
    this._detailPage = 0;
    dlog('SlotMgr', `enterDetailView: ${sessionId}`);
  }

  exitDetailView(): void {
    this._focusedSessionId = null;
    this._view = 'list';
    this._detailPage = 0;
    this._modelSwitching = false;
    this._prevModelName = undefined;
    this._modelSwitchStartedAt = 0;
    dlog('SlotMgr', `exitDetailView → list`);
  }

  nextPage(): void {
    if (this._view === 'detail') {
      const total = this.detailOptionPages();
      if (total <= 1) return;
      this._detailPage = (this._detailPage + 1) % total;
      dlog('SlotMgr', `nextDetailPage: ${this._detailPage + 1}/${total}`);
      return;
    }
    const total = this.totalPages();
    if (total <= 1) return;
    this._currentPage = (this._currentPage + 1) % total;
    dlog('SlotMgr', `nextPage: ${this._currentPage}/${total}`);
  }

  // ---- Slot configuration ----

  getSlotConfig(slot: number): SessionSlotConfig {
    if (slot < 0 || slot >= MAX_SLOTS) return { type: 'empty' };

    if (this._view === 'detail') {
      return this.getDetailSlotConfig(slot);
    }
    return this.getListSlotConfig(slot);
  }

  /** Handle button press. Returns action to take. */
  handleSlotPress(slot: number): {
    action: 'enter-detail' | 'exit-detail' | 'select-option' | 'stop' | 'esc' | 'next-page' | 'send-prompt' | 'open-gateway' | 'switch-model' | 'none';
    sessionId?: string;
    sessionPort?: number;
    optionIndex?: number;
    optionValue?: string;
    promptText?: string;
  } {
    const config = this.getSlotConfig(slot);

    switch (config.type) {
      case 'session':
        if (config.session) {
          return {
            action: 'enter-detail',
            sessionId: config.session.id,
            sessionPort: config.session.port,
          };
        }
        return { action: 'none' };

      case 'back':
        return { action: 'exit-detail' };

      case 'option':
        if (config.option && config.optionIndex != null) {
          return {
            action: 'select-option',
            optionIndex: config.optionIndex,
            optionValue: config.option.label,
          };
        }
        return { action: 'none' };

      case 'preset':
        if (config.preset?.localAction === 'open_gateway') {
          return { action: 'open-gateway' };
        }
        if (config.preset?.localAction === 'switch_model') {
          return { action: 'switch-model' };
        }
        if (config.preset?.prompt) {
          return { action: 'send-prompt', promptText: config.preset.prompt };
        }
        return { action: 'none' };

      case 'esc':
        return { action: 'esc' };

      case 'stop':
        return { action: 'stop' };

      case 'next-page':
        return { action: 'next-page' };

      default:
        return { action: 'none' };
    }
  }

  getFocusedSession(): SessionInfo | undefined {
    if (!this._focusedSessionId) return undefined;
    return this._sessions.find(s => s.id === this._focusedSessionId);
  }

  // ---- Internal helpers ----

  private totalPages(): number {
    const count = this._sessions.length;
    if (count <= MAX_SLOTS) return 1;
    return Math.ceil(count / SLOTS_PER_PAGE);
  }

  private needsPagination(): boolean {
    return this._sessions.length > MAX_SLOTS;
  }

  private isAwaitingDetailState(): boolean {
    return this._detailState === State.AWAITING_OPTION
      || this._detailState === State.AWAITING_PERMISSION
      || this._detailState === State.AWAITING_DIFF;
  }

  private detailOptionPages(): number {
    if (!this.isAwaitingDetailState()) return 1;
    return Math.max(1, Math.ceil(this._detailOptions.length / SessionSlotManager.DETAIL_OPTIONS_PER_PAGE));
  }

  private getListSlotConfig(slot: number): SessionSlotConfig {
    const needsPage = this.needsPagination();
    const sessionsOnPage = needsPage ? SLOTS_PER_PAGE : MAX_SLOTS;

    // Last slot on page = NEXT→ when paginating
    if (needsPage && slot === MAX_SLOTS - 1) {
      return { type: 'next-page', label: `${this._currentPage + 1}/${this.totalPages()}` };
    }

    const startIdx = this._currentPage * SLOTS_PER_PAGE;
    const sessionIdx = startIdx + slot;

    if (sessionIdx < this._sessions.length) {
      const session = this._sessions[sessionIdx];
      return {
        type: 'session',
        session,
        isActive: session.id === this._activeSessionId || session.port === this._activeSessionPort,
      };
    }

    return { type: 'empty' };
  }

  private getDetailSlotConfig(slot: number): SessionSlotConfig {
    const session = this.getFocusedSession();
    const isAwaiting = this.isAwaitingDetailState();
    const isProcessing = this._detailState === State.PROCESSING;
    const isOpenClaw = session?.agentType === 'openclaw';
    const detailOptionStart = this._detailPage * SessionSlotManager.DETAIL_OPTIONS_PER_PAGE;
    const detailOptionPages = this.detailOptionPages();

    // Layout (2×4 grid):
    //   0=BACK   1=INFO   2=content  3=content
    //   4=ESC/STOP  5=content  6=content  7=reserved(expand)
    // Content slots: 1,2,3,5,6 (slot 1=info, rest=options/presets/info)

    switch (slot) {
      case 0:
        return { type: 'back', label: 'BACK' };

      case 4:
        // ESC/STOP — below BACK, always visible (dimmed when not actionable)
        if (isAwaiting) return { type: 'esc', label: 'active' };
        if (isProcessing) return { type: 'stop', label: 'active' };
        // IDLE/DISCONNECTED: show dimmed ESC (harmless, clears typed text)
        return { type: 'esc', label: 'dim' };

      case 1:
        return { type: 'info', session, label: session ? this.displayNameFor(session) : 'Session' };

      case 7:
        if (isAwaiting && detailOptionPages > 1) {
          return { type: 'next-page', label: `${this._detailPage + 1}/${detailOptionPages}` };
        }
        return { type: 'empty' };

      default: {
        // Content slots: 2,3,5,6 → option indices (paged)
        const CONTENT_SLOTS = [2, 3, 5, 6];
        const contentIdx = CONTENT_SLOTS.indexOf(slot);
        if (contentIdx < 0) return { type: 'empty' };

        const optionIndex = detailOptionStart + contentIdx;
        if (isAwaiting && optionIndex < this._detailOptions.length) {
          return {
            type: 'option',
            option: this._detailOptions[optionIndex],
            optionIndex,
          };
        }

        // OpenClaw presets (IDLE or PROCESSING without options)
        if (isOpenClaw && !isAwaiting && contentIdx < OC_PRESET_DEFS.length) {
          const def = OC_PRESET_DEFS[contentIdx];
          const iconSvg = def.dynamicIcon === 'model'
            ? buildModelIcon(this._detailModelName, this._modelSwitching)
            : (def.iconSvg ?? '');
          const preset: PresetAction = {
            label: def.label,
            iconSvg,
            color: def.color,
            textColor: def.textColor,
            prompt: def.prompt,
            localAction: def.localAction,
            loading: def.dynamicIcon === 'model' ? this._modelSwitching : undefined,
          };
          return { type: 'preset', preset };
        }

        // PROCESSING: first content slot shows current tool
        if (isProcessing && contentIdx === 0 && this._detailTool) {
          return {
            type: 'info',
            label: this._detailTool,
            session,
          };
        }

        // Claude Code IDLE: show quick action presets (GO ON, REVIEW, COMMIT, CLEAR)
        if (!isOpenClaw && this._detailState === State.IDLE && contentIdx < CC_PRESET_DEFS.length) {
          const def = CC_PRESET_DEFS[contentIdx];
          const preset: PresetAction = {
            label: def.label,
            iconSvg: def.iconSvg ?? '',
            color: def.color,
            textColor: def.textColor,
            prompt: def.prompt,
          };
          return { type: 'preset', preset };
        }

        return { type: 'empty' };
      }
    }
  }
}
