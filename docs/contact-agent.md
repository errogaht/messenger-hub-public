# Внутренний агент общения

Hub самостоятельно находит адресата, читает историю, загружает или создаёт профиль
и переписывает исходное сообщение. Командующий агент передаёт содержание и адресата;
ему не нужны локальные навыки Telegram/WhatsApp или пути к профилям для этого потока.
Модель не получает инструментов и не выбирает адрес отправки. Доступ к каналам,
разрешение на отправку, длина текста и журнал доставки контролируются кодом Hub.

## Инструменты

- `messenger_contact_search`: локальный поиск имён/псевдонимов, префиксов и близких
  написаний (SQLite FTS5 + ограниченная опечатка). `discover: true` дополнительно
  ищет в доступных провайдерах. Предложения не являются подтверждённой личностью.
- `messenger_contact_prepare`: предпросмотр. Может создать контакт/профиль, но не
  отправляет сообщение. Возвращает окончательный текст и выбранный адрес.
- `messenger_contact_send`: основной путь общения, сразу подготовить и отправить.
  Не требует предварительного отдельного вызова prepare. Для отправки предпросмотра
  используется тот же requestId и тот же исходный payload в течение 15 минут.
- `messenger_send_raw`: точная отправка без LLM, профиля и изменения текста.
- `messenger_send`: прежний точный контракт v1 для WorkZone и старых клиентов.
- `messenger_contact_delivery`: состояние подготовки/отправки по requestId.
- `messenger_contact_save`, `messenger_contact_merge`, `messenger_contact_profile_set`,
  `messenger_personality_set`: управление адресной книгой и правилами с правами владельца.

Пример обычной отправки (только при разрешении пользователя отправить):

```json
{
  "recipient": "Иван Примеров",
  "connectionId": "telegram-main",
  "requestId": "report-unique-command-id",
  "text": "Исправил поиск заказа. Проверил результат."
}
```

`recipient` — имя/псевдоним или стабильный ID контакта. `connectionId` задаёт аккаунт,
а не просто тип мессенджера. Если адресов несколько, укажи `conversationId`.
Если получены `needs_recipient`/`needs_route`, выбирай по подтверждённой личности,
а не по первому элементу. Hub не выбирает автоматически между несколькими каналами.
Для найденного нового человека используется один точный результат каталога
провайдера; незавершённый или недоступный поиск не разрешает автоподстановку.

## Контакты и профили

Приватный каталог `assistant.root` содержит SQLite-адресную книгу и Markdown.
Контакт имеет стабильный ID, имя, псевдонимы, revision, allowSend и несколько
адресов `connectionId + conversationId + kind`. Один адрес принадлежит одному
контакту. Отрицательные Telegram ID и групповые WhatsApp JID импортируются как
группы; групповой профиль не становится профилем отдельного участника.

Общий профиль человека используется во всех связанных каналах. Для конкретного
диалога можно добавить override через `contact_profile_set`. Приоритет стилевых
правил: override диалога → профиль человека → personality.md. Смысл исходного
сообщения и ограничения системного промпта имеют приоритет над стилем.

Новый профиль строится по последним 100 сообщениям выбранного диалога и до трёх
дополнительных доступных личных адресов этого человека. Анализ голоса опирается на
исходящие сообщения. В короткой/неполной выборке отмечаются ограничения уверенности.
Полные экспорты в профиль не сохраняются. Текстовая выборка ограничена 60 000
символов на диалог; пропуск больших сообщений явно отмечен.

Голосовые распознаются в общем слое Hub, и внутренний агент получает помеченную
транскрипцию вместе с историей. Видео распознаётся только явно. Картинки и документы
эта версия внутреннего агента НЕ интерпретирует: она меняет стиль предоставленного
текста и не отвечает на неувиденные вложения. См. `media-search-wait.md`.
В результате предпросмотра есть `mediaNotInspected`; исходный агент должен передать
уже установленные факты, если отчёт зависит от содержимого вложений.

Профили перечитываются с диска перед новой подготовкой. `personality.md` можно
редактировать напрямую. Версии профиля имеют отдельные Markdown-файлы: текущий
путь хранится в таблице profiles, а INDEX.md после импорта служит начальным указателем.
Изменение через MCP создаёт новую версию; старые файлы сохраняются для восстановления.
Профиль автоматически создаётся при отсутствии, существующий автоматически не
перезаписывается из-за единичной реплики. Уточнения владельца вносятся через MCP.

`contact_merge` применяется только после подтверждения, что два контакта — один
человек. Он сохраняет адреса, псевдонимы и оба исходных профиля. При конфликтующих
стилях владелец может уточнить общий профиль и исключения диалогов.

## Права и приватность

`assistant: true` в scope включает инструменты агента; `contactAdmin: true` даёт
редактирование/объединение. Дополнительно каждый используемый адрес требует read
и profiles, а отправка — send. Источники общего профиля записаны отдельно от Markdown:
проект без доступа ко всем источникам не может прочитать или применить такой профиль.
Нельзя получить знание чужого портала через общий профиль человека.

Исходные профили импортируются по точным ID, имена не объединяются автоматически.
`scripts/import-profiles.mjs CONFIG_PATH` повторяем: уже связанные адреса пропускаются,
текущие профили и правки владельца не перезаписываются. Исходные каталоги не меняются.

LLM-ключ хранится отдельным файлом 0600, модель/effort заданы конфигурацией. Вызов
Responses использует `store: false`, тайм-аут и не повторяется автоматически.
Профили и ограниченная история передаются настроенному провайдеру для обработки.
[Формат reasoning в Responses](https://developers.openai.com/api/docs/guides/reasoning).

Прежний журнал Hub хранит только метаданные. Новая приватная contacts.sqlite
дополнительно хранит текст подготовки/отправки для точного повторного ответа и
предотвращения повторной генерации. Автоматического удаления этих записей нет;
резервная копия и защита каталога обязательны. Ни ключи, ни профили, ни тексты
запросов не выводятся в штатные логи и не добавляются в Git.

## Состояния, ошибки и повтор

Резервирование requestId происходит до LLM. `preparing`/`sending` после аварии
означают незавершённую операцию, требующую проверки, а не разрешение нового запроса.
`unknown` не ретраится. `failed` означает ошибку подготовки до вызова отправки;
после исправления причины можно начать новый запрос. `needs_review` содержит
предупреждения модели и не отправляется автоматически. Обычный повтор возвращает
сохранённое состояние и точный текст. Изменённый payload с тем же ID запрещён.

Изменение правил действует только на новые подготовки; уже просмотренный текст
не меняется при последующей отправке. Отправка просроченного предпросмотра запрещена.
Ошибка переписывания переключает подготовку на исходный текст с явным
`stylePreparation.status=original_fallback` (с0.7.6); транспорт остаётся прежним.

Числа и URL проверяются кодом на сохранность. Промпт запрещает новые факты,
обещания и изменение уверенности, но это не доказательство полной смысловой
эквивалентности: для важных сообщений используйте предпросмотр или raw.

## Включение и откат

Конфигурация `assistant` содержит root, enabled, baseUrl (HTTPS), keyFile, model,
effort, timeoutMs. Перезапуск сервиса нужен для конфигурации, но не personality.md.
`enabled: false` выключает LLM-подготовку; raw/legacy send продолжают работать.
Уберите assistant-флаги у scope, чтобы скрыть новые инструменты для этого клиента.

Для полного отката восстановите предыдущие исходники и config, перезапустите
messenger-hub.service. Сохраните contacts.sqlite со всеми Markdown-версиями и старый
журнал доставки: их удаление теряет сведения о незавершённых отправках.
Прямые Telegram/GOWA сессии и конфигурация WorkZone не меняются.

После отключения прямых MCP/старых навыков в Codex проверьте также глобальные
AGENTS.md: старое обязательное требование «прочитай telegram-communication»
нужно заменить маршрутом через Hub. Наличие нового инструмента само по себе
не отменяет более приоритетные инструкции старых сессий. Здесь эти инструкции
и прямые подключения по просьбе владельца не удаляются.

## Reply target resolution (Hub 0.7.2)

`replyTo` is an exact message ID in the resolved connection/conversation, not a
requirement that the source fit the recent style-history window. Preparation
first accepts evidence in that history; otherwise it reads the exact cached
message and, only on cache miss, explicitly refreshes it through the same scoped
adapter. Existing provider lookup limits apply (fallback up to 2000 messages).
The model gets `recentHistory.replyTarget` with a bounded excerpt and explicit
`textTruncated`; full text remains available through `messenger_message_get`.
No additional model is used for lookup. No reply is silently downgraded to an
unthreaded send. Lookup failures report stage `reply_context`, actual reason and
correlation ID; a bounded lookup miss is not evidence of deletion.

A previously failed preparation remains durable and is not automatically sent
when the server upgrades. The original caller can repeat its unchanged payload
and requestId with `retryPreparation: true`. A changed payload requires a new
requestId; an unknown send must instead be reconciled, never blindly retried.

## Style fallback (0.7.6)

Styling is optional: when bounded JSON/literal repair fails, or rewrite generation
throws, discard the candidate and use exactly the caller's original `text`.
Do not perform a separate raw send. The usual prepared operation stores this
text, original endpoint/replyTo and the same idempotency key before transport.
`contact_prepare` remains send-free, and `contact_send` reuses its frozen preview.

Additive result metadata (also retained in `contact_delivery`):

```json
{
  "stylePreparation": {
    "status": "original_fallback",
    "reason": "rewrite_changed_numbers_or_links",
    "stage": "rewrite_validation",
    "correlationId": "opaque-id"
  }
}
```

No raw exceptions, discarded candidates, profiles or provider responses are exposed.
For `format:auto` fallback uses `plain` for short sources; long reports use the
existing native `rich_markdown` transport if supported, retaining every source byte.
Explicit supported formats are preserved. The unchanged source must still fit
that format's provider limit; failure reports `source_validation` without sending.
No silent truncation or format substitution. Successful model warnings still
require review. Recipient ambiguity, disabled assistant, read/reply/profile scope
failures, unsupported requested formats and transport failures do not enter this
rewrite-only catch. A separate narrow boundary catches model generation during
new profile creation, returns the original without saving a fake profile, and marks
`stage:profile_generation` with `rewriteAttempts:0`. Profile authorization, history
reads and persistence failures cannot enter that generation-only fallback.

An existing failed preparation is not resent when the server updates. Its caller
may repeat the original payload/requestId with `retryPreparation:true`; unknown
sends require reconciliation, never a fresh requestId or blind repeat.
