<?php

declare(strict_types=1);

/*__HUB_SEND_FENCE__*/

/**
 * Send one bounded text message to the configured chat as the configured portal actor.
 *
 * This reviewed source is streamed over pinned SSH and is never installed in
 * the webroot. Private text is injected as base64 JSON into this stdin stream,
 * so it never appears in process argv. All mutations go through CIMMessenger
 * and the current Bitrix V2 IM permission/reply validators. ORM reads are used
 * only to verify idempotent retries and the final receipt; direct message-table
 * INSERT/UPDATE/DELETE statements are intentionally absent.
 */

$hubInput=json_decode(base64_decode('__HUB_PAYLOAD__',true),true,16,JSON_THROW_ON_ERROR);
define('BITRIX_ROOT',$hubInput['root']);
define('FIXED_USER_ID',(int)$hubInput['actorId']);
define('FIXED_CHAT_ID',(int)$hubInput['chatId']);
define('REQUEST_BASE64',base64_encode(json_encode($hubInput,JSON_THROW_ON_ERROR)));
const MAX_MESSAGE_LENGTH = 20000;

define('NO_KEEP_STATISTIC', true);
define('NO_AGENT_STATISTIC', true);
// Skip only the HTTP page-auth redirect: this stdin worker has no browser
// session. Native IM permission checks remain mandatory in writableChat(),
// ReplyValidator, and CIMMessenger::Add (SKIP_USER_CHECK is never set).
define('NOT_CHECK_PERMISSIONS', true);
$_SERVER['DOCUMENT_ROOT'] = BITRIX_ROOT;
// The intranet license guard only permits its standard service entrypoints.
// These CLI request coordinates avoid rendering the login page while the IM
// operation still runs with an explicit fixed-user permission context.
$_SERVER['SCRIPT_NAME'] = '/bitrix/services/main/ajax.php';
$_SERVER['PHP_SELF'] = '/bitrix/services/main/ajax.php';
$_SERVER['REQUEST_URI'] = '/bitrix/services/main/ajax.php';
$_SERVER['REQUEST_METHOD'] = 'POST';
$_SERVER['HTTP_HOST'] = $hubInput['host'];
$_SERVER['SERVER_NAME'] = $hubInput['host'];
$_SERVER['REMOTE_ADDR'] = '127.0.0.1';

// Bootstrap failures must be structured and explicitly precede any message write.
// Suppress incidental portal output so one JSON receipt remains parseable.
ob_start();
try { require BITRIX_ROOT . '/bitrix/modules/main/include/prolog_before.php'; }
catch (Throwable $error) { ob_end_clean(); echo json_encode(['ok'=>false,'error'=>'portal_bootstrap_failed','stage'=>'bootstrap','message_created'=>false]); exit(1); }
ob_end_clean();

use Bitrix\Im\Message\Uuid as MessageUuid;
use Bitrix\Im\Model\MessageTable;
use Bitrix\Im\V2\Chat;
use Bitrix\Im\V2\Message;
use Bitrix\Im\V2\Message\Reply\ReplyValidator;
use Bitrix\Im\V2\Permission\Action;
use Bitrix\Main\Loader;

/** A bounded validation, permission, or retry conflict safe for MCP output. */
final class ChatBoundaryException extends RuntimeException
{
}

/** Emit exactly one JSON response without traces, credentials, or paths. */
function respond(array $payload, int $exitCode = 0): never
{
    echo json_encode(
        $payload,
        JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR
    );
    exit($exitCode);
}

/** Decode the stdin-injected request and require an object-like JSON value. */
function requestPayload(): array
{
    $decoded = base64_decode(REQUEST_BASE64, true);
    if ($decoded === false || strlen($decoded) > 100000) {
        throw new ChatBoundaryException('Chat request payload is invalid');
    }
    $payload = json_decode($decoded, true, 16, JSON_THROW_ON_ERROR);
    if (!is_array($payload)) {
        throw new ChatBoundaryException('Chat request must be an object');
    }
    return $payload;
}

/** Require a positive integer target without accepting numeric strings. */
function positiveInt(mixed $value, string $name): int
{
    if (!is_int($value) || $value < 1) {
        throw new ChatBoundaryException($name . ' must be a positive integer');
    }
    return $value;
}

/** Require bounded text; matching Bitrix's trim makes retry comparison stable. */
function messageText(mixed $value): string
{
    if (!is_string($value)) {
        throw new ChatBoundaryException('text must be a string');
    }
    $result = trim(str_replace(['[BR]', '[br]', '#BR#'], "\n", $value));
    $length = mb_strlen($result);
    if ($length < 1 || $length > MAX_MESSAGE_LENGTH) {
        throw new ChatBoundaryException('text length is outside the allowed range');
    }
    return $result;
}

/** Validate the caller's opaque idempotency key before deriving a UUIDv4. */
function requestId(mixed $value): string
{
    if (!is_string($value)) {
        throw new ChatBoundaryException('request_id must be a string');
    }
    $result = trim($value);
    if (!preg_match('/^[A-Za-z0-9][A-Za-z0-9._:-]{7,79}$/D', $result)) {
        throw new ChatBoundaryException('request_id contains unsupported characters');
    }
    return $result;
}

/** Derive a stable valid UUIDv4 while keeping request_id out of Bitrix tables. */
function templateUuid(string $requestId): string
{
    $hex = hash('sha256', "messenger-hub-bitrix-v1\0" . $requestId);
    return substr($hex, 0, 8) . '-' . substr($hex, 8, 4) . '-4' .
        substr($hex, 13, 3) . '-a' . substr($hex, 17, 3) . '-' . substr($hex, 20, 12);
}

/** Keep native exception messages useful without exposing paths or controls. */
function safeErrorText(string $message): string
{
    $message = preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u', ' ', $message) ?? '';
    $message = trim(preg_replace('/\s+/u', ' ', $message) ?? '');
    return mb_substr($message !== '' ? $message : 'Bitrix rejected the chat operation', 0, 300);
}

/** Confirm the fixed actor and native Send policy without altering chat state. */
function writableChat(): Chat
{
    $user = CUser::GetByID(FIXED_USER_ID)->Fetch();
    if (!$user || $user['ACTIVE'] !== 'Y') {
        throw new ChatBoundaryException('Configured actor is unavailable');
    }
    $chat = Chat::getInstance(FIXED_CHAT_ID)->withContextUser(FIXED_USER_ID);
    if ($chat instanceof \Bitrix\Im\V2\Chat\NullChat || $chat->getId() !== FIXED_CHAT_ID) {
        throw new ChatBoundaryException('Configured chat is unavailable');
    }
    if ($chat->getRelationByUserId(FIXED_USER_ID) === null || !$chat->canDo(Action::Send)) {
        throw new ChatBoundaryException('Actor cannot send to chat');
    }
    return $chat;
}

/** Validate the reply target through Bitrix's current permission-aware policy. */
function validateReplyTarget(int $replyId, Chat $chat): int
{
    $result = (new ReplyValidator())
        ->withContextUser(FIXED_USER_ID)
        ->validate($replyId, $chat);
    if (!$result->isSuccess()) {
        throw new ChatBoundaryException('Reply target is unavailable in selected chat');
    }
    $validated = (int)($result->getResult()['REPLY_ID'] ?? 0);
    if ($validated !== $replyId) {
        throw new ChatBoundaryException('Reply target failed native Bitrix validation');
    }
    return $validated;
}

/** Resolve the deterministic UUID to an existing message for retry detection. */
function existingMessageId(string $uuid): ?int
{
    $messageId = (new MessageUuid($uuid))->getMessageId();
    return $messageId !== null && $messageId > 0 ? $messageId : null;
}

/**
 * Verify a returned or replayed ID matches the exact fixed-chat operation.
 *
 * This prevents an accidental request_id collision from being reported as a
 * successful retry for another chat, actor, body, or reply target.
 */
function verifiedReceipt(int $messageId, string $text, ?int $replyId): array
{
    $row = MessageTable::getRow([
        'select' => ['ID', 'CHAT_ID', 'AUTHOR_ID', 'MESSAGE', 'DATE_CREATE'],
        'filter' => ['=ID' => $messageId],
    ]);
    if (
        !$row || (int)$row['CHAT_ID'] !== FIXED_CHAT_ID ||
        (int)$row['AUTHOR_ID'] !== FIXED_USER_ID || (string)$row['MESSAGE'] !== $text
    ) {
        throw new ChatBoundaryException('request_id collides with another message');
    }
    $actualReplyId = (new Message($messageId))->withContextUser(FIXED_USER_ID)->getReplyId();
    if ((int)($actualReplyId ?? 0) !== (int)($replyId ?? 0)) {
        throw new ChatBoundaryException('request_id collides with another reply target');
    }
    return [
        'id' => $messageId,
        'chat_id' => FIXED_CHAT_ID,
        'author_id' => FIXED_USER_ID,
        'reply_to_message_id' => $replyId,
        'created_at' => isset($row['DATE_CREATE']) ? (string)$row['DATE_CREATE'] : null,
    ];
}

$sentMessageId = null;
// Once Add starts, an exception is ambiguous even when no ID was returned.
$writeAttempted = false;
$stage='permission_validation';
try {
    if (!Loader::includeModule('im')) {
        throw new ChatBoundaryException('Bitrix IM module is unavailable');
    }
    $request = requestPayload();
    $operation = $request['operation'] ?? '';
    if (!in_array($operation, ['send', 'reply', 'preflight'], true)) {
        throw new ChatBoundaryException('Unsupported chat write operation');
    }
    $chat = writableChat();
    if ($operation === 'preflight') {
        respond([
            'ok' => true,
            'chat_id' => FIXED_CHAT_ID,
            'fixed_user_id' => FIXED_USER_ID,
            'native_send_available' => is_callable(['CIMMessenger', 'Add']),
            'send_fence_supported' => class_exists('HubBitrixSendFence'),
            'send_fence_parent_writable' => str_starts_with((string)getenv('HOME'), '/') && is_writable((string)getenv('HOME')),
        ]);
    }

    $text = messageText($request['text'] ?? null);
    $requestId = requestId($request['request_id'] ?? null);
    $replyId = $operation === 'reply'
        ? validateReplyTarget(positiveInt($request['reply_to_message_id'] ?? null, 'reply_to_message_id'), $chat)
        : null;
    $uuid = templateUuid($requestId);
    $stage = 'send_fence';
    // Same UUID is serialized across all Hub processes, not just one worker.
    // The private sibling directory persists across SSH/process restarts.
    // The SSH account owns its state directory; /var/www may be read-only.
    $fenceHome = (string)getenv('HOME');
    if (!str_starts_with($fenceHome, '/')) throw new RuntimeException('portal_recovery_storage_unavailable');
    $fence = new HubBitrixSendFence($fenceHome . '/.local/state/messenger-hub-bitrix/' . substr(hash('sha256', BITRIX_ROOT), 0, 16), $uuid,
        hash('sha256', json_encode([FIXED_USER_ID, FIXED_CHAT_ID, $text, $replyId], JSON_THROW_ON_ERROR)));
    $beforeId = existingMessageId($uuid) ?? $fence->messageId();
    if ($beforeId !== null) {
        respond([
            'ok' => true,
            'created' => false,
            'idempotent_replay' => true,
            'message' => verifiedReceipt($beforeId, $text, $replyId),
        ]);
    }

    // Private dialogs use the peer's user ID while groups use chat<ID>.
    $hubDialogId='chat'.FIXED_CHAT_ID;
    if ($chat->getType()==='P') {
        $hubPeers=\Bitrix\Im\Model\RelationTable::getList(['select'=>['USER_ID'],'filter'=>['=CHAT_ID'=>FIXED_CHAT_ID,'!USER_ID'=>FIXED_USER_ID],'limit'=>1]);
        $hubPeer=$hubPeers->fetch();
        if(!$hubPeer)throw new ChatBoundaryException('Private peer unavailable');
        $hubDialogId=(string)$hubPeer['USER_ID'];
    }
    $fields = [
        'MESSAGE_TYPE' => $chat->getType(),
        'DIALOG_ID' => $hubDialogId,
        'TO_CHAT_ID' => FIXED_CHAT_ID,
        'FROM_USER_ID' => FIXED_USER_ID,
        'AUTHOR_ID' => FIXED_USER_ID,
        'MESSAGE' => $text,
        'TEMPLATE_ID' => $uuid,
        'SYSTEM' => 'N',
        'URL_PREVIEW' => 'N',
        'WAIT_FULL_EXECUTION' => 'Y',
    ];
    if ($chat->getType()==='P') $fields['TO_USER_ID']=(int)$hubDialogId;
    if ($replyId !== null) {
        // This Bitrix version builds the persisted V2 message from PARAMS.
        // A top-level REPLY_ID alone is accepted but silently sends plain text.
        $fields['REPLY_ID'] = $replyId;
        $fields['PARAMS'] = ['REPLY_ID' => $replyId];
    }
    // Persist uncertainty BEFORE invoking Bitrix. A lost SSH response may be
    // retried only while this checkpoint proves Add has not started.
    $fence->beforeSubmit();
    $stage='native_send';$writeAttempted=true;
    $messageId = CIMMessenger::Add($fields);
    if (!$messageId) {
        $native = $GLOBALS['APPLICATION']->GetException();
        $detail = $native ? safeErrorText((string)$native->GetString()) : 'Bitrix rejected the chat operation';
        throw new ChatBoundaryException($detail);
    }
    $sentMessageId = (int)$messageId;
    $fence->created($sentMessageId);
    $stage='receipt_validation';
    $resolvedId = existingMessageId($uuid);
    if ($resolvedId === null || $resolvedId !== (int)$messageId) {
        throw new ChatBoundaryException('Bitrix did not confirm the idempotent message receipt');
    }
    respond([
        'ok' => true,
        'created' => true,
        'idempotent_replay' => false,
        'message' => verifiedReceipt((int)$messageId, $text, $replyId),
    ]);
} catch (Throwable $error) {
    $fenceCodes = ['portal_send_ambiguous', 'portal_recovery_storage_unavailable', 'request_id_conflict'];
    $fenceCode = in_array($error->getMessage(), $fenceCodes, true) ? $error->getMessage() : null;
    $safe = $error instanceof ChatBoundaryException
        ? safeErrorText($error->getMessage())
        : 'Remote chat operation could not be completed safely';
    // A failed receipt after Add is still a completed write. Tell callers the
    // known ID so they inspect that message instead of sending a new request.
    $codes=[
        'Configured actor is unavailable'=>'actor_unavailable',
        'Configured chat is unavailable'=>'chat_unavailable',
        'Actor cannot send to chat'=>'chat_access_denied',
        'Private peer unavailable'=>'private_peer_unavailable',
        'Reply target is unavailable in selected chat'=>'reply_target_unavailable',
        'Reply target failed native Bitrix validation'=>'reply_target_unavailable',
        'request_id collides with another message'=>'request_id_conflict',
        'request_id collides with another reply target'=>'request_id_conflict',
        'Bitrix did not confirm the idempotent message receipt'=>'portal_receipt_unconfirmed',
    ];
    $failure = ['ok'=>false,'error'=>$fenceCode??($codes[$safe]??($writeAttempted?'portal_write_failed':'request_invalid')),'stage'=>$stage];
    // A previous process may have submitted even if THIS process never did.
    if (!$writeAttempted && $fenceCode !== 'portal_send_ambiguous' && !isset($beforeId)) $failure['message_created']=false;
    if ($sentMessageId !== null) {
        $failure['message_created'] = true;
        $failure['message_id'] = $sentMessageId;
    }
    respond($failure, 1);
}
