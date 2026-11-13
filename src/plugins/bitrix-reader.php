<?php
declare(strict_types=1);
/**
 * Portal-scoped reader streamed over the existing pinned SSH transport.
 * The configured actor must be active and a member of the requested chat.
 * Listing is restricted by b_im_relation; no account-wide admin bypass exists.
 * No installed worker, HTTP endpoint, read receipt or message mutation.
 */
$input = json_decode(base64_decode('__HUB_PAYLOAD__', true), true, 16, JSON_THROW_ON_ERROR);
define('BITRIX_ROOT', $input['root']);
define('CHAT_ID', (int)($input['chatId'] ?? 0));
define('ACTOR_ID', (int)$input['actorId']);
define('UPLOAD_ROOT', BITRIX_ROOT . '/upload');
const MAX_MESSAGES = 100;
mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

/** A validation failure whose bounded text is safe to return to the operator. */
final class ReaderBoundaryException extends RuntimeException
{
}

/** Emit one JSON response without credentials, SQL, or filesystem paths. */
function respond(array $payload, int $exitCode = 0): never
{
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
    exit($exitCode);
}

/** Convert one CLI parameter to a bounded positive integer. */
function positiveInt(mixed $value, string $name, ?int $maximum = null): int
{
    if (!is_string($value) || !preg_match('/^[1-9][0-9]*$/D', $value)) {
        throw new ReaderBoundaryException($name . ' must be a positive integer');
    }
    $parsed = (int) $value;
    if ($maximum !== null && $parsed > $maximum) {
        throw new ReaderBoundaryException($name . ' exceeds the allowed maximum');
    }
    return $parsed;
}

/** Return Disk object IDs linked by Bitrix IM to one authorized-chat message. */
function messageFileReferences(mysqli $db, int $messageId): array
{
    $statement = $db->prepare(
        'SELECT l.DISK_FILE_ID
         FROM b_im_link_file l
         INNER JOIN b_im_message m ON m.ID = l.MESSAGE_ID
         WHERE m.ID = ? AND m.CHAT_ID = ? AND l.CHAT_ID = ?
               AND l.DISK_FILE_ID IS NOT NULL'
    );
    $chatId = CHAT_ID;
    $statement->bind_param('iii', $messageId, $chatId, $chatId);
    $statement->execute();
    $result = $statement->get_result();
    $ids = [];
    while ($row = $result->fetch_assoc()) {
        $diskObjectId = (int) $row['DISK_FILE_ID'];
        if ($diskObjectId > 0) {
            $ids[$diskObjectId] = true;
        }
    }
    return array_map('intval', array_keys($ids));
}

/** Resolve attachment IDs through Bitrix Disk metadata without trusting names. */
function resolveAttachments(mysqli $db, array $references): array
{
    if ($references === []) {
        return [];
    }
    // References are already strict positive integers. Rendering this internal
    // allowlist avoids fragile by-reference variadic binding in mysqli.
    $idList = implode(',', array_map('intval', $references));
    // In this Bitrix IM version FILE_ID/message links contain b_disk_object.ID,
    // not b_disk_attached_object.ID and not b_file.ID. Resolving only through
    // that reviewed chain avoids integer-ID collisions between these tables.
    $sql =
        "SELECT o.ID AS ATTACHMENT_ID, o.NAME, o.SIZE,
                f.CONTENT_TYPE, f.ORIGINAL_NAME, f.SUBDIR, f.FILE_NAME,
                f.HANDLER_ID
         FROM b_disk_object o
         INNER JOIN b_file f ON f.ID = o.FILE_ID
         WHERE o.ID IN ($idList)";
    $statement = $db->prepare($sql);
    $statement->execute();
    $result = $statement->get_result();
    $attachments = [];
    while ($row = $result->fetch_assoc()) {
        $reference = (int) $row['ATTACHMENT_ID'];
        $attachments[$reference] = [
            'attachment_id' => $reference,
            'name' => (string) ($row['NAME'] ?: $row['ORIGINAL_NAME'] ?: 'attachment.bin'),
            'size' => (int) $row['SIZE'],
            'mime_type' => (string) ($row['CONTENT_TYPE'] ?: 'application/octet-stream'),
            '_subdir' => (string) $row['SUBDIR'],
            '_file_name' => (string) $row['FILE_NAME'],
            '_handler_id' => (string) $row['HANDLER_ID'],
        ];
    }
    return $attachments;
}

/** Fetch one page and attach only metadata referenced by those exact messages. */
function readMessages(mysqli $db, ?int $beforeId, int $limit): array
{
    $chatId = CHAT_ID;
    if ($beforeId === null) {
        $statement = $db->prepare(
            'SELECT m.ID, m.AUTHOR_ID, m.MESSAGE, m.DATE_CREATE,
                    u.NAME, u.LAST_NAME, u.SECOND_NAME
             FROM b_im_message m
             LEFT JOIN b_user u ON u.ID = m.AUTHOR_ID
             WHERE m.CHAT_ID = ?
             ORDER BY m.ID DESC LIMIT ?'
        );
        $statement->bind_param('ii', $chatId, $limit);
    } else {
        $statement = $db->prepare(
            'SELECT m.ID, m.AUTHOR_ID, m.MESSAGE, m.DATE_CREATE,
                    u.NAME, u.LAST_NAME, u.SECOND_NAME
             FROM b_im_message m
             LEFT JOIN b_user u ON u.ID = m.AUTHOR_ID
             WHERE m.CHAT_ID = ? AND m.ID < ?
             ORDER BY m.ID DESC LIMIT ?'
        );
        $statement->bind_param('iii', $chatId, $beforeId, $limit);
    }
    $statement->execute();
    $result = $statement->get_result();
    $messages = [];
    while ($row = $result->fetch_assoc()) {
        $messageId = (int) $row['ID'];
        $references = messageFileReferences($db, $messageId);
        $resolved = resolveAttachments($db, $references);
        $attachments = [];
        foreach ($references as $reference) {
            if (isset($resolved[$reference])) {
                $metadata = $resolved[$reference];
                unset($metadata['_subdir'], $metadata['_file_name'], $metadata['_handler_id']);
                $attachments[] = $metadata;
            }
        }
        $authorName = trim(implode(' ', array_filter([
            (string) ($row['NAME'] ?? ''),
            (string) ($row['SECOND_NAME'] ?? ''),
            (string) ($row['LAST_NAME'] ?? ''),
        ])));
        $messages[] = [
            'id' => $messageId,
            'author_id' => (int) $row['AUTHOR_ID'],
            'author_name' => $authorName,
            'created_at' => (string) $row['DATE_CREATE'],
            'text' => (string) $row['MESSAGE'],
            'reply_to_message_id' => replyId($db, $messageId),
            'attachments' => $attachments,
        ];
    }
    return $messages;
}

/** Native reply identity is optional; absent history rows are never tombstones. */
function replyId(mysqli $db, int $id): ?int {
    $stmt = $db->prepare("SELECT PARAM_VALUE FROM b_im_message_param WHERE MESSAGE_ID=? AND PARAM_NAME='REPLY_ID' LIMIT 1");
    $stmt->bind_param('i', $id); $stmt->execute();
    $row=$stmt->get_result()->fetch_assoc(); return $row ? (int)$row['PARAM_VALUE'] : null;
}
try {
    $settings=include BITRIX_ROOT . '/bitrix/.settings.php';
    $c=$settings['connections']['value']['default'];
    $db=new mysqli($c['host'],$c['login'],$c['password'],$c['database']);
    $db->set_charset('utf8mb4');
    $db->query('SET SESSION TRANSACTION READ ONLY');
    $db->begin_transaction(MYSQLI_TRANS_START_READ_ONLY);
    $actor=ACTOR_ID;
    $stmt=$db->prepare("SELECT ID,NAME,LAST_NAME FROM b_user WHERE ID=? AND ACTIVE='Y'");
    $stmt->bind_param('i',$actor); $stmt->execute();
    $actorRow=$stmt->get_result()->fetch_assoc();
    if(!$actorRow) throw new ReaderBoundaryException('actor_unavailable');
    $limit=max(1,min(100,(int)($input['limit']??50)));
    if($input['operation']==='list') {
        $offset=max(0,(int)($input['offset']??0));
        $query='%' . ($input['query']??'') . '%';
        $stmt=$db->prepare("SELECT c.ID,c.TITLE,c.TYPE,
          (SELECT CONCAT_WS(' ',u.NAME,u.LAST_NAME) FROM b_im_relation peer JOIN b_user u ON u.ID=peer.USER_ID WHERE peer.CHAT_ID=c.ID AND peer.USER_ID<>? LIMIT 1) AS PEER_NAME
          FROM b_im_chat c JOIN b_im_relation r ON r.CHAT_ID=c.ID
          WHERE r.USER_ID=? AND (c.TITLE LIKE ? OR CAST(c.ID AS CHAR)=? OR c.TYPE='P') ORDER BY c.ID DESC LIMIT ? OFFSET ?");
        $exactQuery=(string)($input['query']??'');
        $stmt->bind_param('iissii',$actor,$actor,$query,$exactQuery,$limit,$offset);$stmt->execute();
        $rows=$stmt->get_result()->fetch_all(MYSQLI_ASSOC);
        respond(['ok'=>true,'chats'=>$rows,'actor'=>['id'=>(string)$actorRow['ID'],'name'=>trim($actorRow['NAME'].' '.$actorRow['LAST_NAME'])]]);
    }
    $chat=CHAT_ID;
    $stmt=$db->prepare('SELECT ID FROM b_im_relation WHERE CHAT_ID=? AND USER_ID=?');
    $stmt->bind_param('ii',$chat,$actor);$stmt->execute();
    if(!$stmt->get_result()->fetch_assoc()) throw new ReaderBoundaryException('chat_access_denied');
    // A missing UUID does not prove nondelivery (e.g. prior deletion). Never resend.
    // Verify route, actor, exact body and reply before confirming an existing ID.
    if($input['operation']==='receipt') {
        $hex=hash('sha256', "messenger-hub-bitrix-v1\0".$input['request_id']);
        $uuid=substr($hex,0,8).'-'.substr($hex,8,4).'-4'.substr($hex,13,3).'-a'.substr($hex,17,3).'-'.substr($hex,20,12);
        $stmt=$db->prepare('SELECT m.ID,m.CHAT_ID,m.AUTHOR_ID,m.MESSAGE FROM b_im_message_uuid u JOIN b_im_message m ON m.ID=u.MESSAGE_ID WHERE u.UUID=?');
        $stmt->bind_param('s',$uuid);$stmt->execute();$row=$stmt->get_result()->fetch_assoc();
        $text=trim(str_replace(['[BR]','[br]','#BR#'], "\n", $input['text']));
        $verified=$row && (int)$row['CHAT_ID']===CHAT_ID && (int)$row['AUTHOR_ID']===ACTOR_ID && $row['MESSAGE']===$text && (int)(replyId($db,(int)$row['ID'])??0)===(int)($input['reply_to_message_id']??0);
        respond(['ok'=>true,'message'=>$verified?['id'=>(int)$row['ID']]:null]);
    }
    if($input['operation']==='history') {
        $before=isset($input['before']) ? (int)$input['before'] : null;
        respond(['ok'=>true,'messages'=>readMessages($db,$before,$limit)]);
    }
    if($input['operation']!=='attachment') throw new ReaderBoundaryException('operation_unsupported');
    $message=(int)$input['messageId'];$attachment=(int)$input['attachmentId'];
    if(!in_array($attachment,messageFileReferences($db,$message),true))throw new ReaderBoundaryException('attachment_not_in_message');
    $rows=resolveAttachments($db,[$attachment]);$metadata=$rows[$attachment]??null;
    if(!$metadata || $metadata['_handler_id']!=='')throw new ReaderBoundaryException('attachment_unavailable');
    $root=realpath(UPLOAD_ROOT);$filename=realpath(UPLOAD_ROOT.'/'.$metadata['_subdir'].'/'.$metadata['_file_name']);
    if(!$root||!$filename||!str_starts_with($filename,$root.DIRECTORY_SEPARATOR)||!is_file($filename)||filesize($filename)>26214400)throw new ReaderBoundaryException('attachment_path_denied');
    respond(['ok'=>true,'attachment'=>['base64'=>base64_encode(file_get_contents($filename)),'filename'=>$metadata['name'],'mimeType'=>(new finfo(FILEINFO_MIME_TYPE))->file($filename)?:'application/octet-stream']]);
} catch(Throwable $e) {
    respond(['ok'=>false,'error'=>$e instanceof ReaderBoundaryException?$e->getMessage():'portal_read_failed'],1);
}
