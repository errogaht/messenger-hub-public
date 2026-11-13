# Messenger Hub

Самостоятельно развёртываемый MCP-сервис общения для агентов и локальных приложений. Он объединяет
мессенджеры, контакты, историю, файлы, распознавание и подготовку сообщений через
единый интерфейс. Telegram/GOWA продолжают владеть существующими сессиями: новая
авторизация Telegram или перепривязка WhatsApp для Hub не нужна.

Версия: **0.9.0**, wire contract **2** с совместимостью прежнего контракта,
plugin contract **1**, HTTP/read contract **1**. Фактический каталог публикуется инструментом `messenger_schema`.
Реально доступные инструменты и подключения зависят от прав конкретного credential.

[Установка и персональные настройки](docs/installation.md) · [Контракт](docs/contract.md) · [MIT](LICENSE)

Публичная поставка — отдельный экспорт исходников без приватной Git-истории,
задач, отчётов и runtime-данных. Подробности: [релиз](docs/public-release.md).

## Native Telegram mentions / selected read-only collector

## Inbox origin / author — HUB021

Immutable subscription cutover, additive event.ingestion provenance1, historical/live/
unknown и activity basis. Late media сохраняет происхождение исходного source;
from_now теперь сохраняет все events, фильтр находится у consumer. Author labels из
уже полученных provider данных, untrusted и отдельны от exact senderId.
[Точный контракт и compatibility](docs/inbox-provenance.md). Poll discovery не считается
подтверждённым native live; legacy/missing evidence == review. Native доказательство
требует producer capture proof; штатный GOWA пока его не предоставляет.

## Rust Clerk / cached reads

## Текущее состояние и ограничения

## Подключения и маршрутизация

Модель: `plugin → connection (аккаунт/портал) → conversation → message/call`.
Одинаковый ID чата в разных аккаунтах означает разные назначения. Подключение
фиксирует аккаунт/портал, исполнителя и транспорт. Сервер проверяет разрешения
на подключение, конкретный чат и действие. Выбор проекта или AGENTS.md задаёт
рабочие правила, но не заменяет серверные права.

| Адаптер | Что умеет | Ограничения |
|---|---|---|
| Telegram | Диалоги, контакты, история, поиск, текст/ответы, Rich Messages, фото/файлы/голос/аудио/видео, скачивание | Существующий MCP-мост; поиск расширяет окно до 1000 совпадений |
| WhatsApp | Диалоги, контакты, история, поиск, текст/ответы, фото/файлы/голос/аудио/видео, скачивание, нативная проверка replyTo | GOWA; только plain-текст; у voice/audio нет подписи; старые quote links могут быть неизвестны |
| Bitrix | Несколько независимых порталов, доступные актору чаты, история/вложения, текст/нативные ответы | Текущий адаптер — self-hosted PHP через закреплённый SSH launcher; для облачного портала нужен REST-плагин; отправка медиа не реализована |
| Email export | Локальные .eml, MIME/вложения, cached history | Read-only, без IMAP/SMTP/native mail push; операторские roots, Python3 stdlib |
| МТС | Контакты архива, звонки, исходные записи и полный Palatine-текст из MTS MCP | Не запускает МТС sync/ASR; только проверенный provider=palatine, чтение всех страниц кэша, без повторного платного распознавания |

В personal scope сейчас доступны Telegram, WhatsApp и МТС. Bitrix доступен через
отдельные разрешённые credentials. `connections` и `health` показывают актуальные
capabilities, состояние мостов, версию, buildId, schemaHash и совпадение исходников
с работающей сборкой. `schema` публикует фактические входы инструментов.

## Чтение, поиск и события

- Каталог диалогов и провайдерских контактов с поиском и пагинацией.
- История в полном и компактном виде; исходные ID, даты, направление, ответы,
  правки/явные удаления, вложения и статусы транскрипций сохраняются.
- Настраиваемые пределы текста/транскрипции, фильтр по типам вложений и строгий
  `maxResponseChars` для **всего сериализованного MCP result**, без JSON-RPC/SSE framing.
  В compact по умолчанию 16000 символов. `maxTotalChars` ограничивает только текст.
- Продолжение `next` не теряет сообщения. Snapshot cursors привязаны к scope,
  маршруту и параметрам; срок действия — 24 часа. Повторять надо те же параметры.
- Полное сообщение по точному ID через `message_get`; большой компактный элемент
  явно помечается `detailsOmitted`. Ограниченный fallback ищет до 2000 сообщений;
  отсутствие в этом окне не доказывает удаление.
- Нативный поиск Telegram, Unicode-поиск по истории выбранного WhatsApp-чата и поиск по уже наблюдённым готовым аудиотранскрипциям.
  Для других адаптеров — просмотр одной страницы истории с явным `coverage`.
  WhatsApp возвращает `coverage=provider_history_unicode_search_plus_observed_audio`;
  cursor связан с chat/query и продолжает с первого непросмотренного offset.
  Лимит500 строк на вызов ограничивает работу, а не глубину всего поиска: используйте next.
  Это не глобальный поиск по всем голосовым аккаунта.
- Журнал событий с независимым курсором каждого потребителя: наблюдённые новые
  сообщения/правки/удаления, ID и хеши. Это не фоновый сбор всех чатов и не push.
- Ожидание серии входящих и паузы после последнего: точные подписки, режим inbound/all,
  `afterMessageId`, независимый возобновляемый cursor. Результат — сводка, затем нужно
  прочитать историю. `history_gap` и `burst_limit` — явные ограничения, не пустой ответ.

## Адресная книга, профили и внутренний агент

- Приватная адресная книга людей: стабильные ID, имена, псевдонимы, несколько
  подтверждённых адресов в разных каналах, revision и разрешение `allowSend`.
- Поиск точных имён/адресов, префиксов и близких написаний; `discover:true` ищет
  также в провайдерах. Предложение не является подтверждением личности.
- Разрешение `self` / «Избранное», телефона, contactId и точного endpoint.
  Неоднозначные имена или несколько каналов дают `needs_recipient` / `needs_route`.
- Явное создание/обновление и объединение контактов владельцем. Revision защищает
  от потерянных правок; один endpoint не может принадлежать двум людям.
- Общий Markdown-профиль человека, override конкретного диалога и глобальный
  `personality.md`. Приоритет: override → профиль → personality; смысл запроса выше стиля.
- Профиль автоматически создаётся при отсутствии по ограниченной истории;
  существующий не перезаписывается после каждой реплики. Изменения через MCP
  сохраняют версии; новая подготовка перечитывает актуальные файлы.
- Повторяемый импорт старых профилей по точным ID, без объединения однофамильцев.
- `contact_prepare` создаёт черновик, а `contact_send` выполняет обычную отправку:
  Hub выбирает подтверждённый маршрут, читает историю/профиль и меняет стиль через LLM.
- Предпросмотр действует 15 минут. Отправка с тем же requestId и исходным payload
  использует тот же готовый текст/формат; просроченный preview не отправляется.
- Голосовые транскрипции доступны агенту стиля; изображения и документы он **не
  интерпретирует**, видео требует явного распознавания. Есть `mediaNotInspected`.
- Контроль сохранности чисел и URL, модельные предупреждения `needs_review`,
  понятные этапы ошибок. Это не гарантия полной смысловой эквивалентности.
- Выключаемая LLM-подготовка, `store:false`, тайм-аут. Сбой переписывания больше
  не блокирует отправку: исходник сохраняется как обычный prepared result с
  `stylePreparation.status=original_fallback`. Raw/legacy остаются независимыми от LLM.

Подробнее: [внутренний агент](docs/contact-agent.md).

## Отправка и проверка результата

- Обычная отправка с внутренней подготовкой; точная raw-отправка; совместимый
  legacy `send` для WorkZone. Отправка и ответ на конкретное сообщение.
- Plain и нативные Telegram `rich_markdown` / `rich_html`: заголовки, таблицы,
  ссылки, код, сворачиваемые `<details>`. Telegram auto выбирает rich по содержимому.
  Raw требует явного формата. Адаптер проверяет ID и обязательные нативные блоки, отвергает неполное представление.
- Отправка местного медиа или зарегистрированного `fileId`: фото, документ,
  OGG/Opus voice, аудио, видео; подписи и replyTo согласно capabilities канала.
- `media_stage` делает неизменяемую копию под scope и SHA-256, **не отправляя** её.
  Местный файл должен находиться в `uploadRoot`, возвращаемом `connections`.
- Стабильный `requestId` привязан к точному payload; журнал записывается до сети.
  Повтор возвращает прежнюю операцию, изменённый payload с тем же ID отклоняется.
- Незавершённые и `unknown` операции не пересылаются автоматически. `delivery`,
  `contact_delivery` и `media_delivery` читают/сверяют прежнюю отправку без дублирования.
- `provider_sent` подтверждает отправку провайдером; доставка и прочтение получателем
  могут остаться unknown. `replyVerification` — отдельная проверка confirmed/mismatch/
  unavailable/not_requested. Старое неизвестное reply нельзя восстановить намерением.
- Ошибка `format_validation` сообщает allowedFormats; при смене payload нужен новый
  requestId. Неизменённая failed preparation может допускать явный `retryPreparation`.

Отправка требует запроса владельца. Наличие инструмента не разрешает тесты на клиентах.

## Медиа, скачивание и распознавание

Подробнее: [медиа, поиск и ожидание](docs/media-search-wait.md).

## Фоновые подписки и очередь для клерка

Hub сам опрашивает явно выбранные routes при включённом worker, сохраняет source
версии и cursor страниц независимо от потребителей. CAS подписки, независимые
consumer offsets, lease/replay/ack после durable сохранения, settled пакеты с
reply/context/file IDs и immutable event_get. Позднее ASR audio даёт media_ready/
media_failed; отправки, Markdown и запуск агентов не входят в этот контур.

## Маркеры работы на сообщениях — HUB-030 /0.7.0

Единый `messenger_message_mark`: viewed 👀, in_progress 👨‍💻, completed ✅,
question 🤔. Telegram использует native custom green-check и сохраняет посторонние
реакции; WhatsApp заменяет одну собственную реакцию. Требуются существующие exact
read/send grants. Durable requestId, отдельный `messenger_message_mark_result`,
unknown без слепого повтора; WhatsApp подтверждает provider receipt, readback unknown
не восстанавливается автоматически. Другие платформы пока unsupported.
[Контракт/ограничения](docs/message-markers.md) · [Промпт системе задач](docs/task-system-marker-prompt.md).
Проверки writes — synthetic; реальные клиентские реакции для тестов не отправляются.

## Все MCP-инструменты

| Инструмент `messenger_…` | Назначение |
|---|---|
| `video_thumbnail` | Cached/native превью без скачивания оригинала |
| `video_prepare` | Явная подготовка видео и timestamped ASR |
| `video_status` | Состояние видео без нового платного запроса |
| `video_read` | Полная транскрипция видео по страницам |
| `video_frames` | Кадры/обрезка из скачанного оригинала |
| `message_mark` | Поставить рабочую реакцию на точное исходное сообщение, stable requestId |
| `message_mark_result` | Читать/сверять durable результат без повторной реакции |
| `identity` | Verified account self ID/username через существующий bridge; native mention фильтр |
| `connections` | Разрешённые подключения, capabilities и uploadRoot |
| `health` | Состояние Hub или одного подключения, версия/сборка |
| `schema` | Фактический каталог и входные схемы |
| `conversations` | Каталог диалогов/звонков, поиск и страницы |
| `contacts` | Контакты провайдера или fallback-каталог |
| `history` | Полная/компактная история, фильтры, бюджет, next |
| `message_get` | Одно полное сообщение по маршруту и ID |
| `search_messages` | Поиск в выбранном чате и наблюдённых ASR |
| `group_ensure` | Scoped создание/восстановление приватной owner+bot forum-группы |
| `group_result` | Сохранённый результат группы без внешних действий |
| `events` | Прежний ID-журнал наблюдения; сам не собирает новые входящие |
| `subscription_save` | CAS настройка/пауза фонового сбора точного route |
| `subscription_status` | Синхронизация, coverage/gap и media counts |
| `inbox_consumer_ensure` | Независимый durable consumer фиксированных подписок |
| `inbox_claim` | Settled пакет с lease, replay и бюджетом всего MCP result |
| `inbox_ack` | Ack после сохранения; сдвигает только этот consumer |
| `inbox_event_get` | Полный immutable снимок конкретной source версии |
| `inbox_projects` | Проверка operator-confirmed bindings/revision без расширения grants |
| `inbox_replay` | Bounded raw backlog snapshot, durable страницы/cursors без ack |
| `inbox_context` | Наблюдённое окно и exact reply chain; явная ограниченность покрытия |
| `inbox_diagnostics` | Observed/acked positions, backlog/lag/lease/freshness/gap/media |
| `wait_for_settled_message` | Ожидание серии и паузы, возобновляемый cursor |
| `attachment` | Совместимое получение одного вложения, base64 |
| `file_download` | Скачать один fileId, метаданные и SHA-256 |
| `files_download` | Скачать до 20 fileIds с отдельными результатами |
| `transcribe_media` | Явное распознавание аудио/видео или retry |
| `transcription_status` | Статус и результат без новой задачи |
| `media_stage` | Заморозить локальный файл без отправки |
| `send_media` | Разрешённая отправка медиа, caption/replyTo |
| `media_delivery` | Сверить прежнюю отправку медиа и связь ответа |
| `profile` | Прочитать разрешённый профиль диалога |
| `contact_search` | Адресная книга людей, discovery, адреса |
| `contact_resolve` | Разрешить self/телефон/ID/точный endpoint |
| `contact_save` | Владельцу: создать/обновить контакт и адреса |
| `contact_merge` | Владельцу: объединить подтверждённые личности |
| `contact_profile_set` | Владельцу: общий профиль/override, новая версия |
| `personality_set` | Владельцу: глобальные правила общения |
| `contact_prepare` | Подготовить черновик без отправки |
| `contact_send` | Обычная отправка через внутреннего агента |
| `contact_delivery` | Состояние подготовки/отправки по requestId |
| `send_raw` | Точная отправка без LLM/переписывания |
| `send` | Совместимая точная отправка прежнего контракта |
| `delivery` | Квитанция точного исходного payload/requestId |

Assistant/admin/write-инструменты скрываются при отсутствии соответствующих прав;
инструменты медиа — если слой медиа не настроен. Проверка прав повторяется на вызове.

## Практические пределы

| Что | Предел |
|---|---|
| Plain Telegram / WhatsApp | До 4096 символов |
| Telegram Rich Messages | До 30000 символов |
| Отправка/стейджинг файла | До 25 MiB; caption до 1024 символов |
| Скачивание Telegram / WhatsApp | До 256 MiB; Bitrix / MTS base64 до 25 MiB |
| Обычный audio-ASR | До 25 MiB и 20 минут |
| Явный video-ASR | До 256 MiB и 60 минут; локальный staging ограничен 25 MiB |
| ASR по умолчанию | 2 workers, очередь до 500, тайм-аут 60 секунд; конфигурируется |
| Ожидание ASR страницы | По умолчанию 15 секунд; audioWaitMs от 0 до 30000 |
| Settled wait | `maxWaitMs` до 600000 (600 с), default 50000; `settleMs` до 600000, default 6000; до 20 подписок и 20 активных ожиданий |
| Snapshot history cursor | 24 часа, те же route/options/scope |

Фактические параметры установки могут отличаться; смотрите capabilities и конфигурацию.

Для ожидания ответа до 10 минут передайте `maxWaitMs: 600000` в
`messenger_wait_for_settled_message`. Пауза `settleMs` входит в общий бюджет:
если она не успела завершиться, продолжайте с возвращённым `cursor` и прежними
subscriptions/direction/settleMs. Stdio proxy допускает 630 секунд для этого
инструмента; MCP-клиенту нужен timeout больше 600 секунд (например,
`tool_timeout_sec = 660.0` для messenger). Уже запущенный stdio proxy и клиент
подхватят новые настройки после переподключения.

## Права, хранение и расширение

Loopback HTTP + обязательный Bearer; browser Origin запрещён. Credential выдаёт
конкретные connections/chats/read/send/profiles и отдельные assistant/contactAdmin.
Проверяются принадлежность файла, scope курсора, источники общего профиля и членство
актора Bitrix. Плагин без полного контракта отклоняется до объявления подключения.

Сторонний плагин — явно установленный абсолютный ESM-модуль
`{id, contractVersion:1, create(settings)}`; он не зависит от исходников WorkZone.
Это доверенный локальный код: версии закрепляются, runtime npm-загрузок нет.

Приватные stores содержат квитанции, адресную книгу, версии профилей, подготовленные
тексты, медиа/ASR и cursors. Их нужно сохранять при перезапусках/откате. Общего
автоматического удаления контента нет; 24-часовая валидность history cursor не
означает гарантированное удаление всех приватных данных. Логи не должны раскрывать
ключи, профили или тела файлов. Провайдерские auth/session остаются в мостах.

Scope не изолирует вредоносный процесс с доступом к файлам того же Unix-пользователя.
Для такой границы нужна отдельная изоляция ОС. WorkZone самостоятельно отвечает
за свои задачи, согласования и очередь сообщений; доступность Hub не зависит от WorkZone.

## Запуск и проверка

Подробная настройка: [installation.md](docs/installation.md).

Node >=22.13. Установка: `npm ci`. Запуск:

```sh
MESSENGER_HUB_CONFIG=/private/config.json npm start
```

Config должен иметь права 0600. Для независимого агента используйте scoped STDIO:

```sh
MESSENGER_HUB_CREDENTIAL=/private/project-credential.json node /absolute/path/src/stdio.mjs
```

Credential содержит только loopback MCP endpoint и scoped bearer. `/health` не
раскрывает данные аккаунтов. Изменение конфигурации требует перезапуска; профили
и personality перечитываются при новой подготовке. Можно выключить LLM или autoAudio
отдельно, сохранив остальные пути работы.

[Развёртывание и откат](docs/operations.md) · [Пример конфигурации](config.example.json).
Изолированные тесты не заменяют проверку вашей установки и прав провайдера.

### Bitrix: права и квитанции (0.2.3)
Bitrix conversationId — ID чата b_im_chat, не ID пользователя. Для личного чата
writer проверяет участника и передаёт его user ID в нативный DIALOG_ID. Actor
закреплён настройкой подключения; health показывает его ID/имя. Требуется членство
в чате, права не расширяются автоматически. chat_access_denied сохраняется наружу.
Структурный отказ до вызова нативного Add возвращает failed/messageCreated=false;
ошибки после начала Add, пропавший ответ и неподтверждённые квитанции — unknown.
Read-only UUID reconciliation сверяет чат/автора/текст/reply, не отправляет заново;
отсутствие UUID не доказывает отсутствие исторической отправки.
Подготовка rewrite использует strict Responses json_schema (0.7.4); генерация профиля
остаётся текстовой. Ошибка неподдерживаемого schema возвращается без unconstrained
fallback. Structured output не отменяет проверки фактов, формата и warnings.
rewrite_invalid_json относится к подготовке; одна повторная генерация из исходника,
затем failed/rewrite_parse/sendAttempted=false. Транспортный failed не разрешает
retryPreparation. Корреляции tool/send errors пишутся в journal без текста/профиля.
Точный ID группы участвует в поиске; непроверенный endpoint возвращает
needs_recipient без запуска подготовки. Реальные клиентские маршруты и квитанции в публичную поставку не входят.
Чтение может один раз повториться при пустом ответе и коде SSH/удалённого
процесса255; send/reply автоматически не повторяются. Код255 без вывода не
устанавливает точную причину транспортного сбоя, диагностика отражает это.

## Приватные forum-группы владельца для WorkZone (HUB-017)

`messenger_group_ensure` создаёт одну приватную Telegram forum-супергруппу на
устойчивый `(connectionId, clientKey)`: `WorkZone · <имя клиента>`, владелец и бот из приватной политики установки, только эти два участника. Бот получает управление топиками,
General открыт/виден; клиент не приглашается. `messenger_group_result` читает
сохранённое состояние/ID/проверку состава и прав без внешних действий.

Возможность **выключена по умолчанию**, отдельные groups.ensure/read и политика
точного подключения/ключей. Она не выдаёт разрешения на клиентские сообщения,
произвольные приглашения или агентов. Создание выполняет существующий Telegram
bridge с прежней сессией. Название не идентичность; этапы durable и независимы.
Потерянный ответ → unknown → сверка journal/случайного маркера, без слепого
повторного создания. Частичная группа сохраняется, ничего не удаляется.

### Ограниченный фоновый сбор
`inbox.workerScopes` — необязательный allowlist scopes для history worker. При `enabled: true` список `["clerk-reader"]` запускает только его subscriptions; `[]` не запускает ни одной, отсутствие поля сохраняет прежнее поведение. Cached reads и native ingress не отключаются; scope-specific status/diagnostics отражают gate. Это не разрешает отправку или выполнение задач.

Для исторических результатов Palatine (кроме звонков MTS MCP) `palatine_balance_insufficient` означает недостаточный баланс (HTTP400); аудио сохраняется, после пополнения требуется explicit retry failed/interrupted файлов. Неизвестные provider errors остаются безопасными кодами без body/секретов. Worker выбирает oldest due subscriptions: длинный initial backfill не блокирует новые каналы.

Replay учитывает размеры обоих курсоров в бюджете ответа: заполненная страница не блокирует дальнейшее восстановление журнала.

### MTS MCP: владелец транскрипции (HUB-025)
Звонки читаются из локального архива MTS MCP. Hub не запускает их ASR даже при explicit retry: ключ, баланс и повторные попытки принадлежат MTS MCP. При следующем subscription poll готовый полный текст автоматически обновляет media/journal и доступен Clerk; до готовности сохраняется исходный звонок. Текст из browse preview не используется; `/api/text` проверяется на provider=palatine и читается до конца с ограничением 1 млн символов. Другие движки отклоняются. Исторический источник сохраняет историческую принадлежность, а обработка задач остаётся отдельным workflow. Истёкшая авторизация MTS требует его штатного восстановления; Hub её не обходит.

## Распознавание внутри Hub — HUB-026 / ASR contract2

Рабочий Hub использует **Codex LB** для автоматической расшифровки голосовых и
явной обработки видео. Настройки purpose `media.asrProvider:codexlb` и
`media.codexlb` описаны в [контракте ASR](docs/codexlb-asr.md).
Готовые старые тексты сохранены с исходным source; failed/interrupted повторяются
явно без смены fileId. Нет fallback между сервисами. MTS-owned Palatine-тексты
по-прежнему читаются из MTS MCP без повторного ASR внутри Hub.
Прежние разделы/отчёты о Palatine-only описывают прошлую политику; для текущего
Hub действует этот контракт. Live evidence отдельно в отчёте HUB-026.

MTS: `transcribe_media` теперь явно делегирует выбранный звонок в MTS MCP (возможно платное распознавание), включая старые записи. Принадлежность контакту проверяется до POST. Подписки/history остаются cache-only и не вызывают эту команду. Старое аудио без локального файла также имеет descriptor для ручного запроса. Автоматическое окно MTS — последние 7 дней; старше — только explicit preparation.

### Ранняя видимость звонков — HUB-028
Звонок виден после обнаружения метаданных MTS, до публикации аудио/текста. `message.callState` разделяет recording (pending/published/unavailable), audio (pending/ready/unavailable), transcription и durationSeconds. Присвоение UUID записи после call-only placeholder сохраняет journal sourceId/version; скачивание явно разрешает актуальную запись внутри того же контакта. Late readiness публикуется как media_updated, готовый текст как media_ready. `subscription_status` и `inbox_diagnostics.subscriptions` показывают `sourceSync`: lastIndexedAt/indexAgeSeconds/nextCheckAt/inflight/errorCode/lastSyncOk. HTTP/SSE соединение само по себе не подтверждает свежесть MTS. Источник метаданных — архив MTS; Hub не вызывает discovery/auth или платный ASR при чтении. Откат исходников не удаляет события/consumer offsets.

HUB031 /0.7.1: plain отчёты получают один bounded corrective rewrite при изменении
чисел/ссылок, как rich; повторно неверный текст не отправляется.

HUB-032: replies in contact_prepare/contact_send resolve an exact replyTo separately
from the recent 100-message style context. Cached targets need no provider fetch;
a cache miss triggers scoped message_get refresh (bounded fallback 2000 messages).
Unavailable targets fail at reply_context with the actual lookup error; no silent
reply removal or automatic client resend. Target model excerpts explicitly mark
truncation; full evidence remains available via messenger_message_get.

Native Telegram history/message/events preserve RichMessage visible text through the session-owning bridge decoder, with block metadata and explicit partial-content flags. Rich block mentions are not treated as ordinary entity evidence.

### HUB-037: styling failure preserves the original (0.7.6)

After bounded rewrite repair, an invalid/unsafe candidate or failed rewrite model
request is discarded. Hub prepares/sends the exact original under the same route,
replyTo and requestId; auto fallback uses plain (long supported reports use native rich_markdown), explicit formats remain unchanged.
`stylePreparation: {status: original_fallback, reason, stage, correlationId}` is
durable in preview/send/receipt. Only model generation during new profile creation may also fall back.
Provider limits, read/reply/profile permissions,
model warnings requiring review, and transport ambiguity remain separate gates.
No source is silently shortened and no old request is sent on upgrade. The
Bitrix-specific explicit recovery described below is separate from style fallback. See [contract](docs/contact-agent.md#style-fallback-076).

### HUB-038: fileId image viewing and attachment IDs (0.7.7)

Use `messenger_file_download({fileId: attachments[].fileId})` to read/download a
file by one Hub UUID. JPEG/PNG/WebP/GIF up to 8 MiB are also returned as native MCP
image content, not base64 text/JSON. Larger/unsupported images retain the private
local path and explicit `imagePreview` omission reason. No image interpretation
model is run. Scope checks and exact source binding remain mandatory.

`messenger_attachment` uses `attachments[].id`, e.g. Telegram `message:803134`,
with connectionId/conversationId/messageId. A registered fileId supplied by
mistake is accepted only if scope and all exact source fields match. Unknown
mismatches produce actionable `input_error` diagnostics, never a sender-resend
recommendation. Native image content replaces inline base64 in MCP structured
results; raw Hub/API attachment base64 remains compatible.
See [examples and limits](docs/attachment-identities.md).

### Shared Video Review (HUB-039, contract1)

Пять scoped инструментов: `messenger_video_thumbnail`, `messenger_video_prepare`,
`messenger_video_status`, `messenger_video_read`, `messenger_video_frames`.
Telegram thumbnail читает native preview без скачивания оригинала; прочие каналы
могут вернуть unavailable. Prepare явно допускает только выбранный зарегистрированный
video fileId; скачивание — существующий media pipeline, ASR — отдельный Palatine
async/SRT purpose. Ordinary audio CodexLB и MTS ownership не меняются.
Status/read cache-only, полные source-aligned segments постранично; full PNG/crops
до12 timestamps с исходным разрешением, UUID derivatives через scoped /files/:id
или file_download. Frames требуют cached original. Нет автоматических задач/отправок.

Локальный Video Review CLI и Hub используют единое headless ядро/cache/OS lock.
Legacy receipt/SRT читаются без повторной оплаты; unknown POST не повторяется,
known task resumes GET после restart. Новые extraction — source_zero_padded,
старые — legacy_unverified без выдуманного time shift. Cache/receipt не удаляются
автоматически. `videoReview.enabled` defaultfalse; включение позволяет только
explicit prepare, не массовую обработку истории. Model/endpoints — purpose settings,
не параметры MCP. Подробный контракт/HTTP examples/errors/installation evidence:
[docs/clerk-video-api.md](docs/clerk-video-api.md).

Attachment `video.status` отражает cached progress, не caption/transcription.
Terminal readiness — existing media_ready/media_failed/media_updated journal,
с fileId/mediaRevision и неизменной source version/affiliation. Все scopes и ack/replay
сохраняются; готовность старого видео не делает его новым клиентским поручением.
Ограничения: no paid live ASR acceptance; preview зависит от provider thumbnails;
legacy timestamps не доказаны, exact decoded PTS не обещается. Без оригинала
frames возвращает video_not_cached; unknown требует receipt reconciliation,
не смены profile/удаления cache для обхода.

### Ответ на недоступное сообщение (HUB-032, reply policy1)

`replyTo` — необязательная цитата. Hub проверяет точный source отдельно от
короткого окна истории. Более старое/отредактированное доступное сообщение можно
цитировать; удалённое/не найденное — текст или вложение отправляется в тот же
авторизованный chat/topic без цитаты. Результат содержит `replyFallback` с причиной
и requested/effective reply IDs. Это обычный результат отправки, не отказ/needs_review.
Выбранная цитата сохраняется до I/O, reconciliation использует её при прежнем
requestId. Scope, адресат, текст и topic не заменяются.
При явном Telegram `REPLY_MESSAGE_ID_INVALID` с доказанным no-create возможна
одна отправка без цитаты. Lost/ambiguous transport остаётся unknown, повторной
отправки нет. Старые local `reply_not_in_context` при чтении квитанции корректируются
в failed/not_created без sends. При неизвестном результате старого request сначала
читать delivery; не создавать новый ID вслепую. Проверка sends только fake-транспортами.

### Длительные скачивания (HUB-041, download contract1)
`messenger_file_download({fileId,waitMs:25000})` возвращает `status:ready` с полными
байтами/path/SHA либо `status:downloading`, retryAfterMs и инструкцией продолжения.
waitMs0..25000, default25000; повтор SAMEfileId присоединяется к single-flight,
не начинает второй download. При ready native images продолжают работать.
`files_download` имеет один общий waitMs бюджет и отдельный статус каждого UUID.
Обычные cache hits немедленно возвращают ready. Telegram original read budget —
600000ms, trusted connection setting downloadTimeoutMs1000..1800000. Это не таймаут
send/ASR и не новая сессия. После restart abandoned running отмечается interrupted;
только explicit read повторяет безопасную загрузку, automatic bulk recovery нет.
Read/save scope/source/size checks сохранены, никакой ASR при скачивании не запускается.
Все текущие ошибки после реального отказа сохраняют diagnostics; pending не выдаётся
за готовый файл или общую недоступность. /files/:id предпочтительно читать послеready.

`video_prepare` после восстановленного оригинала возобновляет только доказанный
pre-ASR отказ скачивания. Настройки задачи сохраняются, старый отказ остаётся
в recovery.previousError. `video_status` показывает canResume/error.stage=download,
retryable:true для такого случая. После durable coreStarted/sha и при неизвестном
платном результате автоматического повторного POST нет. Ошибки содержат этап;
готовое видео не сохраняет старую ошибку. Это не массовый сброс задач или ASR.

### Telegram history unknown authors (HUB-042)
Telegram rows with Unknown/no numeric author remain in history: senderId:null,
isSelf:null, no guessed authorLabel. Their IDs/text/media/replies/order remain
present; one unknown author cannot reject an entire provider page. Actual shape
failures expose safe adapter/operation/field/expected/actualType/recordIndex,
never raw body, display names or credentials. Sender/reply identity is parsed
only from headers, never copied from untrusted message text.
`history` accepts `transcribeAudio:false` for inspection/backfill without starting
new ASR; cached transcripts and attachment UUIDs remain available. Optional flag
must be repeated with all cursor options; default autoAudio behavior unchanged.

## Telegram: чтение по ссылке, username и названию (HUB-043)

`messenger_history({connectionId:"telegram-main", conversationId:"t.me/lpr1_Krasnodar_alarm", readMode:"refresh", limit:30})`
разрешает канал через существующую Telegram-сессию и возвращает канонический
числовой `conversationId`. Поддерживаются ID, `@username`, username, публичные
`t.me/username`, `https://t.me/username`, ссылки на публикации (также `/s/` и
числовые `/c/`), полное/частичное название. Публикация выбирает диалог, а не
позицию истории. Точный username имеет приоритет; неоднозначные названия дают
разрешённых кандидатов `id/title/username/kind`. Каналы различаются от групп.

Общий resolver применяется к history, message_get, attachment, search_messages,
message_context и topics; ID проверяется по прежним route grants до чтения и
регистрации файлов. Используйте возвращённый ID для следующих вызовов/курсов.
Writes по-прежнему требуют подтверждённый канонический маршрут. Автовступлений,
новых Telegram-сессий и изменения scopes нет. Cached режим не обращается к
провайдеру; неизвестный alias даёт `conversation_not_cached`, нужен refresh.
Единственное совпадение названия в неполном cache не доказывает уникальность: resolver требует refresh либо подтверждённый ID.

`messenger_conversations(readMode:"refresh")` ищет по username/названию среди
диалогов всех типов и сохранённых контактов. Контакты не прерывают поиск каналов.
Каталог живой, не snapshot; до 5000 диалогов плюс сохранённые контакты, страницы
до 100. `next` продолжается даже при пустой странице после фильтрации scope.
`complete:false` и `coverage.truncated:true` явно отмечают предел; resolver
не объявляет название уникальным или отсутствующим при неполном покрытии.
Точный username работает независимо от этого предела. Названия ищутся среди
существующих диалогов/сохранённых контактов, не во всём публичном Telegram.

## Восстановление history и предел соединений (HUB-044, 0.8.7)

Upstream HTTP использует собственный ограниченный пул: 16 TCP-соединений на
экземпляр адаптера вместо неограниченного глобального fetch dispatcher.
Owner setting `connections.*.settings.upstream.httpConnections` допускает 2..64;
один слот может занимать служебный SSE GET. Остальные HTTP-клиенты/ASR не меняются.
Транспорт закрывает принадлежащий ему пул, не трогая другие соединения/аккаунты.
Автоматического повторения запросов, включая отправки, нет.

Таймаут провайдера теперь отличим как `upstream_timeout`: безопасные поля
`providerOperation`, `transport`, `failureType`, `timeoutMs` и correlationId
не содержат сообщений, URL, аргументов или секретов. Отдельный
`upstream_unavailable` означает транспортный сбой, не отсутствие чата/доступа.
Для history надо повторить прежние параметры и неуспешный cursor после
восстановления провайдера; `requestId` и retry-флаг у history отсутствуют.
Подсказки чтения больше не требуют параметры отправки/подготовки.

### Telegram: coded provider errors and account health (0.8.8)

The bridge's exact `An error occurred (code: …). Check mcp_errors.log for details.`
frame is a failed operation even when MCP marks the envelope successful. Hub
returns a safe provider operation/code, never the private log or an invented
account ID. `messenger_health` requires a positive numeric self identity; a
malformed response raises `telegram_identity_shape` instead of reporting
`available:true` with `self.id="undefined"`. History body text remains data.
No failed operation is automatically replayed; uncertain sends retain their
original receipt rules. Provider authentication failures still require restoring
the existing Telegram bridge session; restarting Hub does not repair a revoked
auth key. Config/grants/auth state are not changed by this normalization.

### Восстановление авторизации Telegram (HUB-046)

На рабочей машине владельца доступна постоянная страница **http://127.0.0.1:34771/**.
Команда `messenger-telegram-login` запускает сервис и открывает страницу в Google Chrome через `xdg-open`, не меняя браузер по умолчанию.
Статус проверяется через свежий account health Hub, без нового Telegram-клиента
и без отправки сообщений. Ошибки MCP health/identity дают `ownerRecovery.command`.
Транспортная ошибка сама по себе не доказывает потерю сессии.

По поручению владельца монитор автоматически начинает **один** повторный вход
при явном `AUTH_KEY_DUPLICATED`, `AUTH_KEY_UNREGISTERED`, `SESSION_REVOKED` или
`SESSION_EXPIRED` в журнале **текущего запуска** Telegram-моста. После готовности
QR он сам открывает новое окно Google Chrome через `xdg-open`; остаётся
отсканировать QR и при необходимости ввести пароль на локальной странице.
Проверка выполняется в фоне (обычно в пределах одного цикла мониторинга).
Обычные timeout/offline/сбой чтения журнала не запускают вход. Один инцидент
фиксируется приватно до запуска, поэтому повторные ошибки и перезапуск
recovery-сервиса не создают бесконечные окна. После неудачи/истечения QR
повторный запуск — кнопкой на странице. Новый успешно авторизованный запуск
моста может вызвать отдельное восстановление при следующем отзыве ключа.
Если Chrome/рабочий стол недоступен, QR остаётся на постоянном URL; окно
автоматически повторно не открывается. Сервис проверяет только существующий
owner account, без отправок и изменения VPN/прав.

1. Открыть страницу и нажать «Проверить подключение».
2. Если нужен новый вход — «Восстановить подключение», подтвердить остановку
   Telegram-моста и отсканировать QR через Telegram → Настройки → Устройства.
3. Если Telegram запросил двухэтапную проверку — ввести **пароль Telegram**,
   не одноразовый код и не PIN телефона. Пароль вводится только на локальной странице.
4. Дождаться «Telegram подключён»: новый аккаунт проверен против selfId,
   временный клиент отключён, existing bridge запущен и Hub подтвердил аккаунт.

Страница различает QR, ввод/проверку/отказ пароля, устаревшую форму,
другой аккаунт, таймаут, сохранённую сессию без подтверждения Hub и рабочее подключение.
Повторные нажатия не запускают параллельный вход. QR ограничен пятью минутами,
пароль — тремя попытками с ожиданием до десяти минут на попытку. При отказе
или таймауте прежний мост запускается снова; автоматических повторов того же входа нет.
Origin проксированного браузера не используется как единственная проверка:
нужны разрешённый loopback Host и актуальный CSRF. Секреты не попадают в URL/логи/status.
Сессия записывается только в `.env` существующего моста; Hub её не получает.
Изменённый во время входа `.env` не перезаписывается.

Установка из этого checkout: `python scripts/install-telegram-recovery.py`.
Используется имеющийся Telegram bridge venv (Telethon/dotenv/qrcode).
Сервис: `systemctl --user status messenger-telegram-recovery.service`.
Остановка: `systemctl --user disable --now messenger-telegram-recovery.service`.
При остановке/сбое recovery-сервиса systemd запускает прежний мост.
Проверки автоматического запуска/дедупликации/ошибок/Chrome выполнены fake-сценариями;
реальный повторный вход и read-only Hub health/history проверяются отдельно в HUB-048.
Это локальный owner-only инструмент для `telegram-main` и `telegram-mcp.service`,
не удалённая веб-панель, не MCP-инструмент входа и не управление другими аккаунтами.
Поддержка WhatsApp/Bitrix/MTS в этом сценарии не добавляется.

Проверки: `python test/telegram-recovery.test.py -v` (fake provider/service +
изолированный HTTP); `npm test`. Живая проверка установки и текущего аккаунта
описана в задаче HUB-046. Новый реальный вход при приёмке не запускается,
чтобы не разлогинивать рабочую сессию; Telegram QR/2FA проверены fake-сценариями
и предшествующим восстановлением HUB-045, не полным новым live-входом.

### Восстановление неизвестного результата текстовой отправки Bitrix (HUB-050)

После транспортного `unknown` повторите **исходный** `contact_send`, `send_raw`
или `send` с прежним requestId и неизменёнными полями. Для Bitrix Hub сначала
сверяет квитанцию, затем при транспортной ошибке может возобновить сохранённую
операцию. Smart send использует прежний подготовленный текст, формат, решение
о цитате и UUID, без новой стилизации; срок preview не отменяет уже начатую
операцию. `canRetrySend:true` и `nextAction` в smart результате объясняют этот путь.
`contact_delivery`/`delivery` остаются проверками без отправки. Telegram, WhatsApp
и media этот механизм не получают. Изменённый payload с прежним ID отклоняется.

На портале один UUID сериализуется файловой блокировкой. Приватный журнал
`$HOME/.local/state/messenger-hub-bitrix/<portalRootHash>` содержит только digest/стадию/ID,
режимы0700/0600, и остаётся вне webroot. До native Add пишется durable checkpoint.
Существующая UUID-квитанция/сохранённый ID возвращаются без нового Add. Если
Add мог начаться, но его результат не подтверждён, `portal_send_ambiguous`
сохраняет unknown и блокирует создание дубля. Отказ хранилища также не разрешает
новую попытку вслепую. Журналы/сообщения/UUID нельзя удалять для «разблокировки».

Для исторических операций до HUB-050 доступна только сохранённая штатная UUID
Битрикса: старого write-ahead checkpoint ещё нет. Восстановление не поддерживает
ручное удаление/изменение провайдерских сообщений, UUID или журнала. Обрыв между
Add и подтверждением теперь различается консервативно, без обещания автоматически
исправить любую неопределённость. Нужен явный повтор отправки, фонового resend нет.

Изолированные Node/PHP fake-тесты покрывают старый unknown, точный payload,
параллельные процессы, потерю ответа, crash после checkpoint и сохранение правил
прочих каналов. Реальная клиентская отправка не является тестом установки.
