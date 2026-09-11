import type {
  ChatMessage,
  ChatMessageKind,
  MessageRole,
  Prisma,
  TravelRecord,
  TravelStatus,
} from "@prisma/client";
import type {
  AnonTokenHash,
  AnonymousTravelRecordOwner,
  hashAnonymousToken,
  TravelRecordOwner,
} from "@/server/anonymous-owner";
import type {
  AppendChatMessageInput,
  AppendChatMessageResult,
  ChatMessageCursor,
  ChatMessagePage,
} from "@/server/repositories/chat-message";
import type {
  CreateTravelRecordInput,
  TransferAnonymousTravelRecordInput,
} from "@/server/repositories/travel-record";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type Assignable<A, B> = [A] extends [B] ? true : false;

export type OwnerCompileTimeContract = [
  Assert<Equal<Assignable<{ userId: string }, TravelRecordOwner>, true>>,
  Assert<Equal<Assignable<{ anonTokenHash: AnonTokenHash }, TravelRecordOwner>, true>>,
  Assert<Equal<Assignable<Record<string, never>, TravelRecordOwner>, false>>,
  Assert<
    Equal<Assignable<{ userId: string; anonTokenHash: AnonTokenHash }, TravelRecordOwner>, false>
  >,
  Assert<
    Equal<Assignable<{ userId?: string; anonTokenHash?: AnonTokenHash }, TravelRecordOwner>, false>
  >,
  Assert<Equal<Assignable<{ anonTokenHash: string }, TravelRecordOwner>, false>>,
  Assert<Equal<Assignable<{ anonToken: string }, TravelRecordOwner>, false>>,
  Assert<Equal<Assignable<{ userId: string }, AnonymousTravelRecordOwner>, false>>,
  Assert<Equal<ReturnType<typeof hashAnonymousToken>, AnonTokenHash>>,
  Assert<Equal<Assignable<string, AnonTokenHash>, false>>,
  Assert<Equal<Assignable<AnonTokenHash, string>, true>>,
  Assert<Equal<CreateTravelRecordInput["owner"], TravelRecordOwner>>,
  Assert<Equal<TransferAnonymousTravelRecordInput["owner"], AnonymousTravelRecordOwner>>,
  Assert<Equal<CreateTravelRecordInput["requirementJson"], null | undefined>>,
  Assert<Equal<AppendChatMessageInput["contentJson"], null | undefined>>,
  Assert<Equal<AppendChatMessageInput["owner"], TravelRecordOwner>>,
];

export type GeneratedTravelAndMessageContract = [
  Assert<
    Equal<
      TravelStatus,
      | "DRAFT"
      | "NEEDS_INFO"
      | "PLANNED"
      | "MODIFIED"
      | "FINALIZED"
      | "NEEDS_REVALIDATION"
      | "ARCHIVED"
    >
  >,
  Assert<Equal<MessageRole, "USER" | "ASSISTANT" | "SYSTEM">>,
  Assert<Equal<ChatMessageKind, "TEXT" | "STRUCTURED">>,
  Assert<
    Equal<
      keyof TravelRecord,
      | "id"
      | "userId"
      | "anonTokenHash"
      | "title"
      | "status"
      | "version"
      | "requirementJson"
      | "createdAt"
      | "updatedAt"
    >
  >,
  Assert<Equal<TravelRecord["userId"], string | null>>,
  Assert<Equal<TravelRecord["anonTokenHash"], string | null>>,
  Assert<Equal<TravelRecord["requirementJson"], Prisma.JsonValue>>,
  Assert<Equal<TravelRecord["status"], TravelStatus>>,
  Assert<Equal<TravelRecord["version"], number>>,
  Assert<Equal<TravelRecord["createdAt"], Date>>,
  Assert<Equal<TravelRecord["updatedAt"], Date>>,
  Assert<
    Equal<
      keyof ChatMessage,
      | "id"
      | "travelRecordId"
      | "role"
      | "kind"
      | "content"
      | "contentJson"
      | "sequence"
      | "clientMessageId"
      | "replyToMessageId"
      | "createdAt"
    >
  >,
  Assert<Equal<ChatMessage["role"], MessageRole>>,
  Assert<Equal<ChatMessage["kind"], ChatMessageKind>>,
  Assert<Equal<ChatMessage["content"], string>>,
  Assert<Equal<ChatMessage["contentJson"], Prisma.JsonValue>>,
  Assert<Equal<ChatMessage["sequence"], number>>,
  Assert<Equal<ChatMessage["clientMessageId"], string | null>>,
  Assert<Equal<ChatMessage["replyToMessageId"], string | null>>,
  Assert<Equal<ChatMessage["createdAt"], Date>>,
  Assert<Equal<AppendChatMessageResult, { message: ChatMessage; replayed: boolean }>>,
  Assert<Equal<ChatMessagePage, { messages: ChatMessage[]; nextCursor: string | null }>>,
  Assert<Equal<ChatMessageCursor, { travelRecordId: string; sequence: number; id: string }>>,
];
