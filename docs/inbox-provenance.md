# Inbox provenance 1 — Hub0.6.1 (HUB021)

Additive envelope `event.ingestion`, опубликован в `schema.inboxProvenanceSchema`;
`inboxProvenanceVersion:1` в health/schema/server info. Wire2/HTTP1/read1 сохранены.
Это producer metadata, не message.text/richMessage, не решение модели.

```json
{
  "ingestion": {
    "version": 1,
    "cutover": {"createdAt":"2026-10-02T10:00:00Z","basis":"subscription_created","clockUncertain":true},
    "sourceOrigin": {"classification":"live_native","basis":"authenticated_producer_live_callback_after_cutover","firstObservedAt":"2026-10-02T10:00:01Z","transport":"telegram_native","providerEventId":"opaque-stable-id","clockUncertain":true},
    "observation": {"transport":"telegram_native","phase":"native_callback","providerEventId":"opaque-stable-id","capturedAt":"2026-10-02T10:00:01Z","gap":false,"providerWindowComplete":null},
    "activity": {"classification":"live_create","basis":"authenticated_producer_live_callback_after_cutover","triage":"fresh"}
  },
  "author": {"id":"exact-provider-sender-id","isSelf":false,"displayName":"Provider display name","labelTrusted":false,"labelEvidence":"provider_display_metadata","evidence":"native_sender_and_account_identity"}
}
```

## Durable cutover и классификация

Новый subscription save транзакционно фиксирует createdAt по часам Hub.
Поле immutable; input не позволяет его менять. Pause/resume меняет только activeSince,
не cutover/consumer offsets. Старые subscription без timestamp получают null/legacy_unknown,
не время обновления/перезапуска. Новый native capture после resume должен быть >=activeSince;
отложенный callback периода pause получает review. Все clocks помечены uncertain:
это не гарантия синхронизации часов или физического времени отправки клиентом.

| Наблюдение | sourceOrigin | activity / triage |
|---|---|---|
| Authenticated native callback с producer capture proof после cutover/activeSince | live_native для нового live_create; creation неизвестна для edit/delete впервые | live_create/live_edit/live_delete, fresh |
| History discovery с timestamp до cutover | historical_snapshot с clock-unverified basis | historical_import, historical |
| History discovery после cutover/неизвестный cutover | unknown | poll_candidate, review |
| Изменился content известного source после durable observation | прежнее происхождение | observed_change, fresh (наблюдённая revision, не доказанная дата native edit) |
| Live edit/delete исторического source | historical_snapshot сохраняется | live_edit/live_delete, fresh |
| Новый native reply к историческому messageId | live_native самого reply | live_create, fresh; exact reply context отдельно |
| Native повтор уже исторического source как live_create | historical_snapshot сохраняется | historical_import, historical; не новое поручение |
| Late Palatine ready/failed | прежнее происхождение source | media_update, historical/live fresh/review по sourceOrigin |
| Legacy/malformed/missing evidence | unknown | unknown/review |

`fresh` — основание рассмотреть изменение, НЕ поручение/authority и не факт доставки.
Clerk продолжает отделять факты, личное, другое project и действия самого участника.
Для более строгой политики Clerk может принимать только live_* и явный owner review;
observed_change не гарантирует, что провайдер показал самую последнюю revision.
Poll source.at используется лишь вместе с history producer path/cutover как conservative
history hint. После-cutover timestamp сам по себе НЕ подтверждает live. Skew может
сделать эту подсказку неверной: sourceOrigin.clockUncertain не скрывается. Backlog
сохраняется полностью независимо от triage, поэтому owner может пересмотреть классификацию.

## Baseline/recovery/legacy compatibility

`initialHistory:available|from_now` принимается по прежней wire schema; **from_now больше
не подавляет начальные events**. Subscription status объявляет
initialHistoryBehavior:retain_all_events_filter_in_consumer. Это намеренное изменение
семантики по поручению владельца: history/live filtering относится к Clerk.
Все страницы baseline/full rescan сохраняются, new-between-save/firstpoll не скрывается.
Recovery ранее неизвестного старого source получает historical hint, не live_create.
Source/event IDs, native bodies, version hashes, sequence/ack/replay не удаляются.
Ранее подавленная legacy history не восстанавливается автоматически как новая активность.
Legacy cutover неизвестен, source origin ledger не выдумывает его.

`inbox_origins` — additive private durable ledger по subscription+source ID; каждый новый
event фиксирует snapshot ingestion. Старые journal rows НЕ переписываются; event_get/brief
добавляют conservative unknown envelope на чтении. Уже frozen legacy batches/replay pages
могут не иметь поля: отсутствие == unknown/review; detailsOmitted требует event_get.
Детальное event_get обеспечивает provenance независимо от compact response budget.
Новые snapshots имеют ingestion; модель не генерирует/не переопределяет эти поля.

Unknown poll discovery, подтверждённая позже live_create, получает дополнительный
`kind:source_evidence_updated` с тем же source.version/versionHash. Старый event остаётся
unknown. Политика Clerk должна учитывать eventId/evidence event, а не считать один
sourceId+version достаточным для игнорирования новой provenance. Повтор native receipt
с тем же providerEventId дедуплицируется до observe. Native edit/delete с уже наблюдённым
content может подтвердиться таким же evidence event без фальшивой content revision.
Native→identical poll не эмитит duplicate; source evidence не понижается до poll.
Изменение только authorLabel не является content edit/новым поручением.

Observation.transport: history_poll/telegram_native/gowa_webhook/palatine_media/unknown.
Phase: initial_snapshot/overlap/recovery_rescan/native_callback/late_media/legacy.
Gap отражает уже известное coverage gap на момент snapshot; gap, обнаруженный при
завершении poll cycle, также виден в subscription_status/diagnostics. Это не полный
аудит provider history. providerWindowComplete — только ответ данной страницы;
не полнота аккаунта и не гарантия отсутствия пропусков.

## Native producer proof

Authenticated `/api/v1/ingest/<connectionId>` принимает optional:

```json
{"producer":{"captureKind":"live_create","capturedAt":"2026-10-02T10:00:01Z"}}
```

captureKind live_create/live_edit/live_delete. Telegram existing-client helper сохраняет
proof вместе с outbox до отправки; lost response/restart использует тот же payload,
не новую capture дату. Никто не создаёт login/session/copies. Native producer от0.6.0
без proof остаётся unknown/review, даже если сообщение выглядит новым по source.at.
Malformed producer input rejected до публикации. CapturedAt в будущем >5s от Hub либо
до cutover/resume не подтверждает live. В пределах clock uncertainty это receipt of
callback, не гарантированное физическое creation время; catch-up/disconnect gaps требуют
scoped recovery review. GOWA штатный signed payload не содержит этого durable proof:
по умолчанию unknown/review; optional подписанный root.hub_producer использует ту же schema
для будущего trusted forwarder. Штатный GOWA producer не изменён; target Workzone сохранён.
HMAC/device/exact grants/subscriptions enforcement прежние, grants не расширены.

## Human author labels

`message.authorLabel?:string(max500)`, `event.author.displayName:string|null`,
labelTrusted:false, labelEvidence:provider_display_metadata|unavailable.
Exact senderId/author.id/account/isSelf остаются идентичностью; label — untrusted text.
Telegram использует имя в существующем history/context ответе, sender entity уже в
native message или users того же topic RPC. WhatsApp sender_name/push_name, Bitrix
optional author_name — только если провайдер их вернул. Group/channel catalog title
не используется как имя автора. Если имени нет, displayName:null; UI показывает unknown/ID.
Нет per-message get_sender/contact discovery/LLM вызовов на cached reads. UI обязан
экранировать подписи; HTML и инструкции в имени не выполняются.

## Проверка

Targeted synthetic: initial100 + save/firstpoll race, rescan old, native edit/reply old,
late Palatine old/new calls, pause/restart/cutover/gap, native→poll/poll→native confirmation,
legacy/malformed envelope и producer, author rename без revision. Full suite130 Node;
existing bridge3 Python scenarios. Real native/worker/push/subscriptions/grants остаются off.
Public version/schema/read-only smoke после установки отдельно в HUB021 report.
