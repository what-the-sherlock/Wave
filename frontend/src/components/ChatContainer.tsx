import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, Hash, Loader2, Lock, Users } from "lucide-react";
import { formatDateSeparator } from "../lib/utils";
import { useSession } from "../hooks/useSession";
import { useChannel, useChannelMembers, useJoinChannel } from "../hooks/useChannels";
import { useMarkRead, useMessages, useMessageSocketEvents } from "../hooks/useMessages";
import { useTypingIndicator } from "../hooks/useTyping";
import { useConnectionStatus } from "../hooks/useConnectionStatus";
import { usePresence } from "../hooks/usePresence";
import { useWorkspaceContext } from "./RequireWorkspace";
import MessageItem from "./MessageItem";
import MessageInput from "./MessageInput";
import ThreadPanel from "./ThreadPanel";
import ChannelMembersPanel from "./ChannelMembersPanel";
import ChannelMenu from "./ChannelMenu";
import MessageSkeleton from "./skeletons/MessageSkeleton";
import type { Message } from "../types/channel";

/** How long to hold off after the latest-seq or scroll position changes
 * before actually calling mark-read — collapses a burst of new messages or
 * scroll events into one call (docs/implementation-roadmap.md Phase 4:
 * "mark-read on scroll, debounced"). */
const MARK_READ_DEBOUNCE_MS = 500;

/** Consecutive messages from the same sender within this window collapse
 * into one group — no repeated avatar/name/timestamp header. */
const GROUPING_WINDOW_MS = 5 * 60_000;

const SCROLL_TOP_THRESHOLD = 150;
const AT_BOTTOM_THRESHOLD = 100;

type RenderRow =
  | { kind: "date"; key: string; label: string }
  | { kind: "unread"; key: string }
  | { kind: "message"; key: string; message: Message; isGrouped: boolean };

export default function ChatContainer({
  channelId,
  initialSeq,
}: {
  channelId: string;
  initialSeq?: number;
}) {
  const workspace = useWorkspaceContext();
  const { data: session } = useSession();
  const { data: channel } = useChannel(channelId);
  const joinChannel = useJoinChannel(channelId);
  const presence = usePresence(workspace.id);

  // Browsing a public channel joins you to it — an explicit product
  // decision (docs/database-design.md §5.2): a workspace member can *see*
  // a public channel's metadata without being a member (RLS's
  // can_read_channel), but its messages require actual membership
  // (is_channel_member). Reaching this page for a public channel the
  // caller hasn't joined yet joins them automatically rather than making
  // them find a separate "Join" button first.
  const needsAutoJoin = channel?.type === "PUBLIC" && channel.role === null;
  useEffect(() => {
    if (needsAutoJoin && !joinChannel.isPending) {
      joinChannel.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run only when the channel itself (or its membership) changes, not on every joinChannel identity change
  }, [needsAutoJoin]);

  const hasAccess = Boolean(channel?.role);

  const { data: members } = useChannelMembers(hasAccess ? channelId : undefined);
  const {
    data,
    isLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useMessages(hasAccess ? channelId : undefined);
  const markRead = useMarkRead(channelId);
  const [threadRootId, setThreadRootId] = useState<string | null>(null);
  const [showMembersPanel, setShowMembersPanel] = useState(false);

  useMessageSocketEvents(hasAccess ? channelId : undefined);

  // Reset per-channel UI state when switching channels — a stale thread or
  // panel from the previous channel would otherwise render against the
  // wrong messages.
  useEffect(() => {
    setThreadRootId(null);
    setShowMembersPanel(false);
  }, [channelId]);

  const messages = useMemo<Message[]>(() => {
    if (!data) return [];
    // Pages are newest-first; each page's own messages are newest-first
    // too — reverse both to get oldest→newest for top-to-bottom rendering.
    return data.pages
      .slice()
      .reverse()
      .flatMap((page) => page.messages.slice().reverse());
  }, [data]);

  const memberById = useMemo(
    () => new Map((members ?? []).map((m) => [m.userId, m])),
    [members],
  );
  const canModerate = workspace.role === "OWNER" || workspace.role === "ADMIN";

  // Captured once when the channel's real membership data first loads, not
  // re-read on every render — otherwise the debounced mark-read calls
  // triggered by simply reading this channel would move the divider out
  // from under the reader mid-scroll.
  const unreadDividerSeqRef = useRef<number | null>(null);
  const unreadDividerCapturedForRef = useRef<string | null>(null);
  if (hasAccess && channel && unreadDividerCapturedForRef.current !== channelId) {
    unreadDividerSeqRef.current = channel.lastReadSeq ?? 0;
    unreadDividerCapturedForRef.current = channelId;
  }

  // Flattens messages into date separators, one "New messages" divider at
  // the seq captured above, and grouped/ungrouped message rows.
  const rows = useMemo<RenderRow[]>(() => {
    const result: RenderRow[] = [];
    const dividerSeq =
      unreadDividerCapturedForRef.current === channelId ? unreadDividerSeqRef.current : null;
    let lastDateKey: string | null = null;
    let lastSenderId: string | null = null;
    let lastCreatedAtMs: number | null = null;
    let dividerInserted = false;

    for (const message of messages) {
      const createdAt = new Date(message.createdAt);
      const dateKey = createdAt.toDateString();
      const crossedDate = dateKey !== lastDateKey;
      if (crossedDate) {
        result.push({ kind: "date", key: `date-${dateKey}`, label: formatDateSeparator(createdAt) });
        lastDateKey = dateKey;
      }

      if (!dividerInserted && dividerSeq !== null && message.seq > dividerSeq) {
        result.push({ kind: "unread", key: "unread-divider" });
        dividerInserted = true;
      }

      const isGrouped =
        !crossedDate &&
        lastSenderId === message.senderId &&
        lastCreatedAtMs !== null &&
        createdAt.getTime() - lastCreatedAtMs < GROUPING_WINDOW_MS;

      result.push({ kind: "message", key: message.id, message, isGrouped });
      lastSenderId = message.senderId;
      lastCreatedAtMs = createdAt.getTime();
    }
    return result;
    // unreadDividerSeqRef.current is a ref, but its *value* is read here
    // deliberately — it is mutated exactly once, during render, on the
    // transition where channel membership data first loads for this
    // channelId (see the block above), and that mutation must force this
    // memo to recompute even though `messages` itself did not change on
    // that same render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, channelId, unreadDividerSeqRef.current]);

  const parentRef = useRef<HTMLDivElement>(null);
  const prevScrollHeightRef = useRef(0);
  const isPrependingRef = useRef(false);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => (rows[index]?.kind === "message" ? 56 : 32),
    overscan: 10,
  });

  const latestSeqRef = useRef<number | undefined>(undefined);
  latestSeqRef.current = messages[messages.length - 1]?.seq;

  const markReadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleMarkRead = (seq: number) => {
    if (markReadTimerRef.current) clearTimeout(markReadTimerRef.current);
    markReadTimerRef.current = setTimeout(() => markRead.mutate(seq), MARK_READ_DEBOUNCE_MS);
  };
  useEffect(() => () => {
    if (markReadTimerRef.current) clearTimeout(markReadTimerRef.current);
  }, []);

  // Stay pinned to the bottom for new messages only when already there —
  // someone reading scrollback shouldn't get yanked down. `isAtBottom`
  // (state, not just the ref) is what drives the jump-to-latest pill.
  // Deliberately runs after every render, not just on `messages.length`
  // changes — a resize or a virtualizer remeasure can change scrollHeight
  // without the message count changing. Safe from an update loop: `atBottom`
  // is a boolean recomputed from the DOM, and setIsAtBottom(same value) is a
  // no-op re-render bailout, not a fresh commit.
  const wasAtBottomRef = useRef(true);
  const [isAtBottom, setIsAtBottom] = useState(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- see comment above; intentionally no deps array
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_THRESHOLD;
    wasAtBottomRef.current = atBottom;
    setIsAtBottom(atBottom);
  });
  useEffect(() => {
    const el = parentRef.current;
    if (!el || !wasAtBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  // Reverse-infinite-scroll: load older messages when scrolled near the
  // top, then restore the reader's position by the exact height the
  // prepended page added (otherwise the viewport jumps). Scrolling back
  // down to the bottom — not just a new message arriving — is also a
  // mark-read trigger, debounced so a burst of scroll events collapses
  // into one call.
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const onScroll = () => {
      if (el.scrollTop < SCROLL_TOP_THRESHOLD && hasNextPage && !isFetchingNextPage) {
        prevScrollHeightRef.current = el.scrollHeight;
        isPrependingRef.current = true;
        void fetchNextPage();
      }
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_THRESHOLD;
      wasAtBottomRef.current = atBottom;
      setIsAtBottom(atBottom);
      if (atBottom && hasAccess && latestSeqRef.current !== undefined) {
        scheduleMarkRead(latestSeqRef.current);
      }
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scheduleMarkRead closes over the current markRead mutation via ref/state, not a dep worth re-binding the listener for
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, hasAccess]);

  useLayoutEffect(() => {
    const el = parentRef.current;
    if (!el || !isPrependingRef.current) return;
    isPrependingRef.current = false;
    el.scrollTop = el.scrollHeight - prevScrollHeightRef.current;
  }, [messages.length]);

  // A new message arriving while already at the bottom is the other
  // mark-read trigger, same debounce as the scroll-driven one above.
  useEffect(() => {
    const latest = messages[messages.length - 1];
    if (hasAccess && latest && wasAtBottomRef.current) {
      scheduleMarkRead(latest.seq);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once per new latest seq, not on every markRead/scheduleMarkRead identity change
  }, [channelId, hasAccess, messages[messages.length - 1]?.seq]);

  // Jump-to-message from search (docs/implementation-roadmap.md Phase 6).
  // The target may be older than what's currently loaded — pagination only
  // walks backward from the newest page, so this keeps fetching older
  // pages until the seq turns up or history runs out, then scrolls to it.
  const [jumpTarget, setJumpTarget] = useState<number | undefined>(initialSeq);
  useEffect(() => {
    setJumpTarget(initialSeq);
  }, [initialSeq, channelId]);
  useEffect(() => {
    if (jumpTarget === undefined || isLoading) return;
    const index = rows.findIndex((r) => r.kind === "message" && r.message.seq === jumpTarget);
    if (index !== -1) {
      wasAtBottomRef.current = false;
      setIsAtBottom(false);
      virtualizer.scrollToIndex(index, { align: "center" });
      setJumpTarget(undefined);
    } else if (hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    } else {
      setJumpTarget(undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run on message-list/pagination-state changes only; virtualizer's identity is stable across those
  }, [jumpTarget, rows, hasNextPage, isFetchingNextPage, isLoading]);

  const jumpToLatest = () => {
    const el = parentRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    if (channel && latestSeqRef.current !== undefined) {
      scheduleMarkRead(latestSeqRef.current);
    }
  };

  const unreadBelow = channel ? Math.max(0, channel.lastMessageSeq - (channel.lastReadSeq ?? 0)) : 0;

  const typingUserIds = useTypingIndicator(hasAccess ? channelId : undefined);
  const typingNames = typingUserIds
    .map((id) => memberById.get(id)?.fullName)
    .filter((name): name is string => Boolean(name));
  const connectionStatus = useConnectionStatus();

  const threadRootMessage = threadRootId ? messages.find((m) => m.id === threadRootId) : undefined;
  const isDm = channel?.type === "DM";
  const dmPeerOnline = channel?.dmPeer && presence[channel.dmPeer.userId]?.status === "online";

  const openThread = (messageId: string) => {
    setShowMembersPanel(false);
    setThreadRootId(messageId);
  };
  const toggleMembersPanel = () => {
    setThreadRootId(null);
    setShowMembersPanel((v) => !v);
  };

  const header = (
    <div className="border-b border-base-300 p-3 flex items-center gap-2 shrink-0">
      {isDm ? (
        <div className="avatar placeholder relative shrink-0">
          <div className="bg-neutral text-neutral-content rounded-full w-6">
            {channel?.dmPeer?.avatarUrl ? (
              <img src={channel.dmPeer.avatarUrl} alt={channel.dmPeer.fullName} />
            ) : (
              <span className="text-xs">{(channel?.dmPeer?.fullName ?? "?").slice(0, 1).toUpperCase()}</span>
            )}
          </div>
          {dmPeerOnline && (
            <span className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full bg-success border border-base-100" />
          )}
        </div>
      ) : channel?.type === "PRIVATE" ? (
        <Lock className="size-4 text-base-content/50" />
      ) : (
        <Hash className="size-4 text-base-content/50" />
      )}
      <span className="font-semibold">
        {isDm ? (channel?.dmPeer?.fullName ?? "Direct message") : channel?.name}
      </span>
      {channel?.topic && <span className="text-sm text-base-content/50 truncate">— {channel.topic}</span>}
      {connectionStatus !== "connected" && (
        <span
          className={`badge badge-sm badge-warning gap-1.5 shrink-0 ${hasAccess ? "" : "ml-auto"}`}
          title="Messages will sync once you're back online"
        >
          <span className="size-1.5 rounded-full bg-current animate-pulse" />
          {connectionStatus === "connecting" ? "Reconnecting…" : "Offline"}
        </span>
      )}
      {hasAccess && !isDm && (
        <button
          type="button"
          className="btn btn-xs btn-ghost ml-auto"
          onClick={toggleMembersPanel}
          title="View members"
        >
          <Users className="size-3.5" /> {channel?.memberCount ?? ""}
        </button>
      )}
      {hasAccess && (
        <ChannelMenu
          channelId={channelId}
          mutedUntil={channel?.mutedUntil}
          onViewMembers={isDm ? undefined : toggleMembersPanel}
        />
      )}
    </div>
  );

  // Gates the whole chat UI, not just a visible "joining" message: until
  // membership is confirmed, nothing below may mount — MessageInput and
  // ThreadPanel both call useChannelMembers(channelId) unconditionally
  // (they don't know about hasAccess), so mounting them one tick early
  // means an avoidable 403 against a non-member. This also covers the
  // initial instant before `channel` itself has loaded, not just the
  // "loaded but not yet a member" case.
  if (!hasAccess) {
    return (
      <div className="flex-1 flex flex-col min-w-0">
        {header}
        <div className="flex-1 flex items-center justify-center gap-2 text-base-content/50">
          {!channel ? (
            <Loader2 className="size-4 animate-spin" />
          ) : channel.type === "PUBLIC" ? (
            <>
              <Loader2 className="size-4 animate-spin" /> Joining #{channel.name}...
            </>
          ) : (
            <span>You&apos;re not a member of this channel.</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex min-w-0">
      <div className="flex-1 flex flex-col min-w-0 relative">
        {header}

        {isLoading ? (
          <MessageSkeleton />
        ) : (
          <div ref={parentRef} className="flex-1 overflow-y-auto">
            <div
              style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}
            >
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const row = rows[virtualRow.index]!;
                return (
                  <div
                    key={row.key}
                    ref={virtualizer.measureElement}
                    data-index={virtualRow.index}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    {row.kind === "date" && (
                      <div className="flex items-center gap-3 px-4 py-2">
                        <div className="flex-1 h-px bg-base-300" />
                        <span className="text-xs font-medium text-base-content/50">{row.label}</span>
                        <div className="flex-1 h-px bg-base-300" />
                      </div>
                    )}
                    {row.kind === "unread" && (
                      <div className="flex items-center gap-3 px-4 py-1">
                        <div className="flex-1 h-px bg-error/50" />
                        <span className="text-xs font-semibold text-error">New messages</span>
                        <div className="flex-1 h-px bg-error/50" />
                      </div>
                    )}
                    {row.kind === "message" &&
                      (() => {
                        const message = row.message;
                        const sender = memberById.get(message.senderId);
                        return (
                          <MessageItem
                            message={message}
                            channelId={channelId}
                            senderName={
                              message.senderId === session?.id
                                ? "You"
                                : (sender?.fullName ?? "Unknown")
                            }
                            senderAvatarUrl={sender?.avatarUrl ?? null}
                            canModerate={canModerate}
                            isOwn={message.senderId === session?.id}
                            isGrouped={row.isGrouped}
                            onOpenThread={openThread}
                          />
                        );
                      })()}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {!isAtBottom && !isLoading && (
          <button
            type="button"
            className="btn btn-sm btn-primary shadow-lg absolute bottom-20 left-1/2 -translate-x-1/2 gap-1"
            onClick={jumpToLatest}
          >
            <ChevronDown className="size-4" />
            {unreadBelow > 0 ? `${unreadBelow > 99 ? "99+" : unreadBelow} new` : "Jump to latest"}
          </button>
        )}

        {typingNames.length > 0 && (
          <div className="px-4 py-1 text-xs text-base-content/50 italic h-5 shrink-0">
            {typingNames.length === 1
              ? `${typingNames[0]} is typing…`
              : typingNames.length === 2
                ? `${typingNames[0]} and ${typingNames[1]} are typing…`
                : `${typingNames.length} people are typing…`}
          </div>
        )}
        <MessageInput channelId={channelId} />
      </div>

      {threadRootMessage && (
        <ThreadPanel
          channelId={channelId}
          threadRootId={threadRootMessage.id}
          workspaceRole={workspace.role}
          onClose={() => setThreadRootId(null)}
        />
      )}

      {showMembersPanel && !threadRootMessage && (
        <ChannelMembersPanel channelId={channelId} onClose={() => setShowMembersPanel(false)} />
      )}
    </div>
  );
}
