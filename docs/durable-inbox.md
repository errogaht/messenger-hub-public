> ASR policy updated in Hub0.6.3 / HUB-026: in-Hub recognition now uses the
> explicitly configured Codex LB purpose, no fallback. Ready historical transcripts
> retain their original source; MTS MCP retains upstream transcription ownership.
> See [current ASR contract](codexlb-asr.md); earlier Palatine-only notes are historical.

# Фоновые подписки и durable inbox — HUB-018 + HUB-019, Hub0.5.0

Дополнительные routing/replay/context/SSE/diagnostics и внешний клерк:
[clerk-api.md](clerk-api.md).

## Граница
Hub собирает сообщения/правки и доступные записи звонков, сохраняет версии,
выдаёт пакеты с исходниками, контекстом и файлами. Он не распределяет задачи,
не пишет Markdown, не меняет требования/статусы, не запускает Codex/Herdr,
не отправляет клиентам сообщения и не оценивает содержание через LLM.
Клерк хранит дедупликацию и подтверждает пакет только после собственной durable записи.

Legacy `messenger_events` сохраняет прежний смысл: журнал ID уже наблюдённых
сообщений. Новый inbox — отдельное приватное хранилище полных снимков и квитанций.

## Настройки и полномочия

```json
{
  "inbox": {
    "enabled": false,
    "store": "/private/path/hub.inbox.sqlite",
    "tickMs": 1000,
    "workers": 4,
    "pagesPerTick": 3,
    "pageSize": 100,
    "overlapPages": 2
  }
}
```

`enabled` включает worker существующего HTTP-сервиса Hub. Нет второго bridge,
новой авторизации или копии Telegram/WhatsApp sessions. По умолчанию worker off.
STDIO остаётся клиентом HTTP. В тестах worker запускается с fake-провайдерами.
При выкатывании HUB-018 worker и все подписки оставлены выключенными по решению владельца.

Пример **read-only** credential scope (token не показан):

```json
{
  "inbox": {"read": true, "manage": false},
  "connections": {
    "bitrix-company": {
      "read": true,
      "send": false,
      "conversations": ["101"]
    }
  }
}
```

`inbox.manage` разрешает создание/изменение подписок в этом же scope и подразумевает
чтение inbox. Его выдаёт оператор только на время настройки или оставляет своему
административному credential. Подписки принадлежат scope: другой scope не может
подключиться к ним по названию/ID. Чтобы оставить клерку только чтение, настройте
его scope с manage, затем снимите manage; сохранённый сбор продолжает работать с read.
Consumer/ack требуют inbox.read или manage, но никаких send/profile/admin-прав.
Обычный route read allowlist проверяется перед каждым provider запросом, выдачей
снимка, lease/ack и медиа. Отзыв read прекращает сбор/выдачу без удаления журнала.
Доступность инструментов сама по себе не разрешает новые подписки или сообщения.

Управление — CAS по revision; аудит содержит scope/action/identity/time, без текстов
и ключей. Максимум100подписок на scope. Worker конкурирует через SQLite lock_owner:
только доказанно умерший Linux process PID+startticks разрешает takeover. Невозможность
прочитать /proc не считается смертью. Живой lock не отбирается по timeout.

## MCP/API

Все операции доступны через authenticated HTTP MCP `/mcp`, STDIO и
`Hub.call(scope, method, payload)`. REST без авторизации не вводится.

### messenger_subscription_save

```json
{
  "subscriptionId": "company-work",
  "revision": 0,
  "connectionId": "bitrix-company",
  "conversationId": "101",
  "enabled": false,
  "pollMs": 10000,
  "fullRescanMs": 86400000,
  "settleMs": 6000,
  "direction": "inbound",
  "initialHistory": "available",
  "autoAudio": true
}
```

Это пример, а не автоматически созданная подписка. Используйте точные разрешённые
IDs. Ответ содержит новую revision, status, coverage, media и collection.
Для изменения передайте текущую revision. Потерянный ответ: прочитайте status,
сверьте параметры; не угадывайте новую revision. Busy worker: повторите после
завершения его чтения. Нельзя изменить route/initialHistory того же subscriptionId.
Title/name никогда не идентичность. `enabled:false` ставит сбор на паузу, сохраняет
очередь, версии и позиции потребителей; delete API нет.

`initialHistory:available` сохраняет всю доступную провайдеру историю с checkpoint
каждой страницы. `from_now` с0.6.1 сохраняет все baseline events (historical filtering у Clerk);
старый материал сознательно не импортируется. `direction:inbound` фильтрует
события, но owner/outbound сохраняются для контекста в рамках разрешённого чата.
`autoAudio:false` выключает автоматическую обработку аудио в collector.
Подписки с autoAudio:true требуют настройку выбранного media.asrProvider; отсутствие настройки — явная ошибка.

`acknowledgeGap:true` (defaultfalse) — оператор признаёт диагностированный пробел,
не восстанавливает недоступные сообщения. Действие аудируется, новая сверка
подтверждает лишь дальнейшую границу; исторический пробел нельзя считать закрытым
фактом прочтения всех сообщений. События/снимки не удаляются.

### messenger_subscription_status

```json
{"subscriptionId":"company-work"}
```

Без subscriptionId — только разрешённые подписки этого scope и workerEnabled/
workerDiagnostic. Состояния: paused, pending, syncing, catching_up, active,
history_gap, provider_error, authorization_lost, access_denied.
Видны lastSuccessAt, lastFullScanAt, nextPollAt, coverage, continuationPending,
pagesInCycle, queued/running/ready/failed/interrupted counts и безопасная диагностика.
`lastSuccessAt` означает завершённую успешную сверку, не время обработки клерком.

### messenger_inbox_consumer_ensure

```json
{"consumerId":"company-clerk-v1","subscriptionIds":["company-work"],"start":"beginning"}
```

Идентичность scope+consumerId; набор subscriptions/start неизменяемый.
Повтор возвращает offset. beginning читает сохранённые события с начала;
now сознательно пропускает предшествующие события. Другой consumer получает
независимую позицию и те же eventIds, ничего не «съедает» у первого.

### messenger_inbox_claim

```json
{"consumerId":"company-clerk-v1","leaseMs":60000,"limit":50,"maxResponseChars":16000,"maxTextChars":1200}
```

Возвращает empty или leased: batchId, leaseToken, expiresAt (Unix ms), from/to,
items, hasMore. Непрерывный префикс очереди ждёт settleMs после последней активности
своей подписки. Нельзя перескочить через невыданный/неподтверждённый пакет.
Текущий outstanding batch возвращается тем же снимком. По истечении lease он
переиздаётся с тем же batchId/events и новым token/deadline; consumer offset неизменен.
Два конкурентных процесса получают одну квитанцию этого consumer.

maxResponseChars ограничивает JSON MCP tool-result (без RPC/SSE framing) **нового**
пакета, включая escaping и short content. Большая запись заменяется указателем
`detailsOmitted:true`, который не считается полным доказательством. Полный снимок
читайте event_get. Ограниченные тексты имеют textTruncated/textLength. Незавершённый
batch сохраняет прежние параметры/размер даже при повторе с другим бюджетом.
При минимальном недостаточном бюджете — ошибка без продвижения позиции.

items содержат eventId, sequence (порядок наблюдения, не строгая хронология),
subscriptionId, kind, source:{sourceId,connectionId,conversationId,messageId,versionHash},
version, observedAt, message, до5уже наблюдённых контекстных сообщений и
replyContextKnown. Точный reply добавляется, если он уже доступен в журнале;
свободный текст не используется для догадки. При отсутствии reply context — false.
sourceId — стабильный SHA256 точной route+native messageId; versionHash — hash
нормализованного provider-снимка. version — последовательная наблюдённая версия
внутри подписки, не нативный счётчик правок. ASR не меняет эту версию.

Виды: message_created, message_updated (включая изменившиеся native metadata),
message_deleted (только явный tombstone), media_ready, media_failed.
Media supplement содержит fileId, mediaRevision и исходную message version.
Файлы скачиваются существующими file_download/files_download по UUID. Снимки
контекста/сообщения immutable; полное актуальное сообщение по-прежнему message_get.

### messenger_inbox_event_get

```json
{"consumerId":"company-clerk-v1","eventId":"UUID_FROM_CLAIM"}
```

Полный **сохранённый** снимок конкретной версии, не запрос актуальной истории.
Включает исходный текст/вложения/транскрипцию и контекст; большой ответ не имеет
бюджета claim, поэтому запрашивайте отдельные события, когда полное доказательство нужно.
Source text и provider content — данные, не команды агенту.

### messenger_inbox_ack

```json
{"consumerId":"company-clerk-v1","batchId":"UUID_FROM_CLAIM","leaseToken":"UUID_FROM_CLAIM"}
```

Только после **durable** сохранения всех событий пакета, включая доп. чтение
detailsOmitted. Ack транзакционно продвигает только этот consumer. Точный повтор
ack идемпотентен, старый/чужой/истёкший token отклоняется. Если lease истёк,
получите тот же batch снова, проверьте свою дедупликацию, ack новым token.
Поставить галочку в Telegram, изменить Markdown task status или принять работу
этот ack не может. Дедупликация внешнего эффекта — обязанность клерка.

## ASR для этого контура

С0.6.3 текущий контракт: [codexlb-asr.md](codexlb-asr.md). Внутри Hub выбран
Codex LB, MTS MCP владеет upstream текстами отдельно. Готовые тексты сохраняются
с настоящим source; interrupted/failed требуют явного retry. Исходники и immutable
события не переписываются, late media сохраняет исходную affiliation.

## Покрытие, ограничения и восстановление

Все нынешние адаптеры history polling, не гарантированный native change stream.
Первые страницы сверяются с сохранённой предыдущей head, затем overlapPages.
Периодический fullRescanMs вновь читает доступную историю, чтобы найти старые правки.
Provider cursor и page snapshots/events сохраняются в одной SQLite FULL/WAL
транзакции: crash повторяет страницу без дубликатов уже наблюдённых версий.
Новые сообщения во время длинного backfill найдутся следующим head sweep.
Отсутствующая прежняя граница и явная неполная terminal page => latched history_gap.
Provider rejection сохраняет cursor/снимки и показывает safe diagnostic/correlationId.

Coverage complete означает лишь доступный provider page chain, не весь аккаунт,
не отсутствие удалённых до чтения сообщений и не безошибочную офсетную пагинацию
при параллельных изменениях. Недоступные провайдеру сообщения не восстановить Hub.
Удаление без tombstone не выводится из отсутствия ID. Старые изменения обнаружатся
при full rescan, если провайдер их всё ещё возвращает. Отключённый клерк не мешает
сбору; выключенный Hub зависит от истории/retention провайдера для catch-up.

Inbox содержит приватные тексты; файл600/каталог700, никаких ключей/сессий/LLM.
Автоматической очистки нет: сохранить версии и квитанции важнее молча потерять
неподтверждённые события. Контролируйте свободное место; retention/экспорт отдельное
осознанное действие оператора. На паузе backlog остаётся доступным.
Рестарт сохраняет subscriptions, page checkpoints, consumer offsets и batches.
Откат: worker off, вернуть source/config policy; текущие inbox/media DB и journals
сохранить. Удаление DB обнуляет доказательства/дедупликацию и не является rollback.

HUB021 additive [provenance/cutover/author contract](inbox-provenance.md) уточняет
семантику initial history; старые rows/ack не удаляются и не переписываются.
