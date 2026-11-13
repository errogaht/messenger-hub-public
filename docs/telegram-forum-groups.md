# Приватные Telegram forum-группы: MCP/API (HUB-017, Hub 0.3.0)

Создание выполняет существующий пользовательский Telegram bridge, через
MTProto. Bot API используется WorkZone для последующей работы с топиками;
Hub не принимает токен бота, не открывает новую сессию и не запускает агента.
WorkZone в этой задаче не изменяется.

## Граница полномочий

Возможность выключена по умолчанию на трёх уровнях: глобальная настройка Hub,
политика точного подключения и отдельный `groups.ensure` credential. Bridge
дополнительно требует `HUB_FORUM_PROVISIONING=1` и приватный абсолютный путь
`HUB_FORUM_JOURNAL`. В обычной конфигурации флаг bridge отсутствует/равен0.

Владелец, бот и префикс задаются оператором в политике подключения Hub
и независимом приватном файле политики bridge; см. [установку](installation.md).
Значения 100000001 и `example_forum_bot` ниже синтетические. Политика и bridge проверяют фактический `get_me`, `isSelf`
и отсутствие bot-флага. Бот должен быть настоящим ботом с точным username;
его числовой ID закрепляется при первом разрешении и проверяется при продолжении.

Допускается только название с префиксом `WorkZone · `, не более128 символов.
Группа новая, приватная, megagroup+forum, созданная владельцем; точный состав:
владелец и этот бот. Клиент не добавляется. Непредусмотренные участники,
публичный username, связанный чат, потеря creator или изменение маркера
блокируют дальнейшие действия; участников автоматически не удаляем.

Выдаётся только `manage_topics`. Telegram может возвращать также базовый
флаг администратора `other`; `invite_users`, `add_admins`, управление контентом,
звонками и остальные права не запрашиваются и блокируют `ready`, если обнаружены.
Описание базового `other`: https://core.telegram.org/constructor/chatAdminRights.

`groups` не даёт прав на чтение истории, отправку сообщений, приглашение других
людей, создание клиентских уведомлений или запуск агентов. Это отдельные права
и отдельные поручения. Полученный ID не добавляется в существующие allowlist чатов.

## Операции

### messenger_group_ensure / Hub.call(scope, 'group_ensure', payload)

| Поле | Тип | Значение |
|---|---|---|
|connectionId|string|Точное разрешённое подключение, например telegram-main|
|clientKey|string,1–300|Неизменяемый внешний ключ клиента, с пространством WorkZone|
|title|string,1–128|WorkZone · имя клиента|
|botUsername|string|@example_forum_bot; @ необязателен, регистр нормализуется|
|requestId|string|Стабильный ID запроса, правила Hub id|

Идентичность группы — `(connectionId, clientKey)`, общая для разрешённых scopes.
Название не является ключом. Разные clientKey с одинаковым названием — разные
группы. Повтор с тем же клиентом возвращает прежнюю группу, даже если в новом
requestId изменено название; существующую группу при этом не переименовываем.
Повтор старого requestId с изменёнными параметрами: `idempotency_conflict`.
Request ID привязан внутри scope+connection. При смене credential сохраняйте
точный clientKey; новую группу это не создаёт.

```json
{
  "connectionId": "telegram-main",
  "clientKey": "workzone:client:client_123",
  "title": "WorkZone · Пример клиента",
  "botUsername": "@example_forum_bot",
  "requestId": "workzone-group-client_123-v1"
}
```

### messenger_group_result / Hub.call(scope, 'group_result', payload)

```json
{"connectionId":"telegram-main","clientKey":"workzone:client:client_123"}
```

Только чтение сохранённого результата. Не вызывает Telegram, не продолжает
этапы. Работает с `groups.read` или `groups.ensure`, в том числе после выключения
создания. `verification.checkedAt` — время последнего наблюдения провайдера;
результат является снимком, а не обещанием неизменности внешней группы.
Чтобы актуально сверить и продолжить, повторите авторизованный group_ensure.

HTTP API — существующий аутентифицированный MCP `/mcp`:
`tools/call` с `name: "messenger_group_ensure"` / `messenger_group_result`
и указанными `arguments`. Отдельный незащищённый REST endpoint не вводится.
Одинаковая реализация используется через HTTP, STDIO и программный Hub.call.
Обновите каталог MCP клиента после изменения настройки/перезапуска; сравните
`messenger_schema` и `listTools`, `health.server.sourceMatchesRunningBuild`.

## Результат

Общие поля: status, connectionId, clientKey, requestId, policyId, ownerId,
botUsername, botId (после разрешения), title, stage, completedStages,
conversationId, chatId (одинаковые строки с каноническим markedID `-100…`),
openUrl, verification, diagnostic, nextAction, createdAt, updatedAt.
До подтверждения создания chatId/conversationId равныnull.
Первый requestId сохраняется в операции, даже если к ней обращались с новым ID.
`not_found` возвращается без идентификаторов группы, когда журнала ещё нет.

| status | Смысл |
|---|---|
|in_progress|Этап исполняется или ключ удерживает другой живой процесс|
|ready|Всё проверено по реальному состоянию провайдера|
|partial|Группа существует, но получен определённый отказ/неполное подтверждение|
|blocked|До создания обнаружено несоответствие полномочий/аккаунта/бота|
|unknown|Ответ потерян или недостаточно доказательств внешнего результата|
|not_found|group_result не нашёл операции для этого ключа|

Снимок `verification` содержит private, forum, ownerIsCreator, participantIds,
participantsComplete, participantsExact, botIsAdmin, botRights, botRightsExact,
general:{id:"1",exists,hidden,closed}, ready, checkedAt.
Полный список участников сверяется с count, а не только с первой парой людей.
Hub отдельно проверяет полноту этих доказательств перед `ready`.

`openUrl` — `https://t.me/c/<bare_channel_id>/1`, ссылка на General для участника;
это не пригласительная ссылка и не предоставляет постороннему доступ.
Нативная схема: https://core.telegram.org/api/links. Пригласительную ссылку не выпускаем.

## Надёжность и восстановление

Этапы: create → add_bot → promote_bot → general_unhide → general_open → verify.
Уже подтверждённые состояния пропускаются. General может быть открыт с момента
создания, поэтому отдельного изменения для него может не потребоваться.

До действий сохраняется резерв клиента/requestId и текущий этап в SQLite Hub.
Перед каждым MTProto действием bridge атомарно сохраняет pending-этап в отдельный
журнал: запись через временный файл, fsync, rename, fsync каталога. Сразу после
ответа создания сохраняется markedID. Права сессии остаются в прежнем runtime.

В Hub конкурентные запросы сериализуются по clientKey; разные процессы защищены
атомарным SQLite lock_owner. Только доказанно умерший процесс допускает takeover;
тайм-аут живого процесса не освобождает право создания. PID reuse различается по
start ticks `/proc`. Это Linux-реализация. Bridge удерживает flock через awaits,
включая создание; блокировка автоматически снимается при смерти процесса.

CreateChannel не имеет application random_id: https://core.telegram.org/method/channels.createChannel.
Телеграм-клиент используется через view того же sender/session с нулём
application retries; настройки общего клиента не изменяются. Повтор транспортного
MTProto сообщения остаётся ответственностью исходного sender; повтор нового
CreateChannel после тайм-аута запрещён.

До создания генерируется случайный маркер192 бит. Он передаётся в about группы
в том же CreateChannel, затем сверяется вместе с creator и владельцем.
Маркер — приватные технические метаданные операции, не название и не clientKey.
Нельзя менять description вручную, пока требуется автоматическая сверка.
Он не передаётся в публичном результате Hub.

После неизвестного создания сначала проверяются bridge journal/точный markedID.
Если ID потерян, bridge проверяет описание собственных групп в ограниченном
окне до500 диалогов. Уникальный точный маркер, creator и полное окно обязательны;
совпадение имени/первый результат/пустая выборка не являются доказательством.
Не найдено, несколько совпадений или окно неполное → unknown; новую группу
не создаём. При отсутствии bridge journal после уже заявленного create Hub также
требует сверку и не разрешает чистое создание. Не удаляйте журналы при откате.

Invite/admin/General — восстанавливаемые этапы: сначала чтение участников/прав/
топика, затем только недостающий узкий setter. Определённый запрет бота/прав
оставляет группу и stage; после устранения причины повторите group_ensure с тем
же clientKey. Нельзя менять requestId ради обхода unknown. Нет автоматического
удаления/выхода/сноса группы или приглашения клиента.

## Настройки администратора без секретов

Пример включения **конкретного** подключения/клиента (после явного выбора владельца):

```json
{
  "groupProvisioning": {
    "enabled": false,
    "connections": {
      "telegram-main": {
        "enabled": false,
        "policyId": "workzone-owner-forums-v1",
        "ownerId": "100000001",
        "botUsername": "example_forum_bot",
        "titlePrefix": "WorkZone · ",
        "clientKeys": ["workzone:client:client_123"]
      }
    }
  }
}
```

В grant подключения выбранного scope добавьте независимо от read/send:

```json
{"groups":{"ensure":false,"read":true,"clientKeys":["workzone:client:client_123"]}}
```

Для создания нужны оба enabled=true, groups.ensure=true и разрешённый clientKey
в обеих allowlist. `"*"` допускается только при явной администраторской политике
для всех клиентов этого подключения; безопасный пример ограничен одним ключом.
В systemd drop-in **существующего** telegram-mcp.service задайте
`HUB_FORUM_PROVISIONING=1` и `HUB_FORUM_JOURNAL=<private absolute directory>`.
Не копируйте auth/session и не меняйте bridge account ради устранения отказа.

Каждое ensure/result и стадийное действие пишутся в `hub_group_audit`: время,
scope, connection, hash(clientKey), policyId, requestId, action, decision. Снимок владельца/
бота закреплён в записи операции. Изменение policyId для старой операции блокирует
продолжение; выполняйте осознанную миграцию политики, не подменяйте контекст.

Политика защищает Hub credentials, не вредоносный процесс с shell-доступом от
того же Unix пользователя к исходному loopback bridge. Граница ОС не усилена.

## Ошибки и диагностика

| Код | Следующее действие |
|---|---|
|group_not_authorized / group_provisioning_disabled|Проверить явную политику/allowlist; не переключать credential для обхода|
|group_owner_mismatch|Остановить создание; сверить actualSelfId/expectedOwnerId|
|group_bot_invalid / group_bot_identity_changed|Сверить username и закреплённый ID бота; не подменять его|
|group_admin_required|Сверить права текущего владельца; группа сохраняется|
|group_bot_invite_denied|Устранить запрет Telegram/бота; затем продолжить существующий ключ|
|group_creation_unconfirmed / group_provider_unconfirmed|Сверка того же ключа, не новое создание|
|group_identity_evidence_mismatch|Маркер/creator не подтверждены; вмешательство владельца|
|group_privacy_forum_or_membership_mismatch|Внешнее состояние изменено; ручная проверка, без автоудалений|
|group_operation_in_progress|Дождаться выполняющегося этапа; читать group_result|
|group_rate_limited|Дождаться снятия лимита, затем продолжить тот же ключ|
|group_verification_incomplete / group_verification_invalid|Использовать сохранённый ID для диагностики; продолжать только с достоверной сверкой|

Diagnostic содержит безопасный code/stage, без provider exceptions/ключей/session.
Ошибки Hub дополнительно получают correlationId. Частичный результат содержит
достоверно сохранённый group ID; это не означает завершённость всех этапов.

## Проверка и откат

Bridge extension: bridges/telegram-hub-forum.py, установлен как tools/hub_forum.py;
импорт в tools/__init__.py. Это один явный локальный модуль, не загрузчик плагинов.
Откат: выключить флаги/ensure grants, оставить group_result/read; вернуть исходники
Hub и удалить только импорт/модуль этого расширения. Исходный bridge/session,
контакты, медиа, существующие сообщения не меняются. SQLite hub_groups/requests/audit
и каталог bridge journal сохраняйте; созданная группа остаётся для владельца.
