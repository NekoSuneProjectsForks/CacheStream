/**
 * Platform-neutral types for the multi-platform layer (Twitch / Kick /
 * YouTube / VPzone). Provider clients normalize their native chat/alert
 * payloads into these shapes and publish them on the existing bus topics
 * ("chat" / "alerts") with a `platform` tag, so overlays/commands/automod
 * stay provider-agnostic (they just gain a small platform badge).
 *
 * See docs/design/multi-platform-accounts.md.
 */

export type Platform = "twitch" | "kick" | "youtube" | "vpzone";

export const PLATFORMS: Platform[] = ["twitch", "kick", "youtube", "vpzone"];

export interface PlatformChatMessage {
  type: "msg";
  platform: Platform;
  channelId: string;
  id: string | null;
  login: string | null;
  name: string | null;
  color?: string | null;
  /** Twitch-style "set/ver,set/ver" badge string for the chat overlay. */
  badges?: string | null;
  message: string;
  isMod: boolean;
  isSub: boolean;
  at: number;
}

export interface PlatformAlert {
  platform: Platform;
  channelId: string;
  type: "follow" | "sub" | "gift" | "resub" | "cheer" | "raid" | "host" | "other";
  userName: string;
  /** Provider-specific fields (amount, tier, viewers, …) for rich overlays. */
  raw: Record<string, unknown>;
  at: number;
}

export interface PlatformClient {
  readonly platform: Platform;
  start(): Promise<void>;
  stop(): void;
  send(text: string): Promise<void>;
  status(): { state: "idle" | "connecting" | "connected" | "closed"; lastError: string | null };
}
