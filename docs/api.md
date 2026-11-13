# VoxChat 设备接口 v2

基础路径：`<DSH origin>/voxchat/api`。这是插件协议，客户端实现不在此仓库中。

除 `GET /status` 和 `POST /pair` 外，所有接口必须发送 `Authorization: Bearer <device-token>`。不接受查询参数中的凭证，不公开管理 HTTP 接口。管理操作通过 DSH 的 owner Remote `voxchat/view` 与 `voxchat/command` 完成。

## 1. 配对

在 DSH「设置 → 语音交互」中添加设备并保存，取得一次性配对码。设备完成配对后，在设备卡片中勾选可用工作区。同一设备可以关联多个工作区，增加授权时无需再次配对。

```http
POST /voxchat/api/pair
Content-Type: application/json

{"code":"管理端显示的配对码"}
```

响应：

```json
{"deviceId":"设备ID","workspaceId":"当前工作区ID","workspaceIds":["工作区A","工作区B"],"token":"设备凭证"}
```

配对码为 6 位字母或数字，服务端签发大写字符，输入时忽略首尾空格及大小写。有效期 5 分钟，成功后即失效。仅创建设备及管理员手动刷新时签发；到期或页面重载不会续期。手动刷新立即废弃旧码，已配对设备不能刷新。每 IP 每分钟最多 30 次配对请求，整个插件每分钟最多 120 次；失败和成功请求都计数。

设备凭证只在此响应中返回；客户端应安全保存。解除某个工作区关联只收回对应授权，撤销设备或实际访问地址变化都会使原凭证立即失效。地址变化会清除全部旧配对码并终止活动请求，保留设备配置和授权；用户在原设备卡片手动刷新配对码后重新绑定。设备名称由管理端添加时指定。尚未授权工作区的设备也可配对，此时 `workspaceId` 为 `null`、`workspaceIds` 为 `[]`；管理员后续授权后，客户端再查询并选择工作区。

二维码使用以下链接格式（示例地址和配对码仅用于说明）：

```text
voxchat://pair?server=https%3A%2F%2Fdsh.example.com&code=ABC234
```

二维码仅携带 DSH 地址 `server` 和一次性配对码 `code`，不编码版本号、到期时间、模型密钥或持久设备凭证。客户端可在应用内扫码，或注册 `voxchat://pair` 的系统链接处理。解码后验证协议、HTTP(S) 地址和 6 位配对码，向目标 DSH 的 `/voxchat/api/pair` 发送 `{"code":"ABC234"}`；5 分钟有效期由服务端校验，以配对接口返回结果为准，不把扫码本身视为绑定成功。管理页面在“配对码”标题旁显示有效期，到期后隐藏二维码。二维码和手动输入共用同一配对流程。

手动 DSH 地址非空时使用该地址，留空自动启动公网隧道。二维码始终包含实际 `server`；入口未就绪时隐藏二维码，配对及受保护请求返回 `503 CONNECTION_NOT_READY`。未提供有效 `server` 的链接不能用于扫码配对，不用手机本机地址推断 DSH 入口。地址变化后不能沿用旧 token，需用户重新配对。二维码与配对码同步过期、手动刷新；完整规则见 [连接与隧道说明](connection.md)。

## 2. 设备与会话

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/status` | 插件在线状态、协议版本，无配置及绑定信息 |
| GET | `/me` | 本设备、所选音色与完整音色列表、全部已授权工作区、当前工作区、当前会话和语音配置可用状态 |
| GET | `/voices` | 本设备所选音色与完整共享音色库，返回 `{voiceId, items: [{id,name,value}]}` |
| PUT | `/voice` | 为调用设备选择音色，JSON：`{"voiceId":"..."}`；`null` 清空选择，返回与 `/voices` 相同的结构 |
| GET | `/workspaces` | 本设备已授权且仍存在的 DSH 工作区，返回 `{workspaceId, items: [...]}` |
| PUT | `/workspace` | 选择已授权工作区，JSON：`{"workspaceId":"..."}`，返回 `{workspaceId, sessionId, ready}` |
| GET | `/sessions` | 当前工作区的 DSH 会话列表，返回 `{workspaceId, items: [...]}` |
| GET | `/sessions/:sessionId/history?before=100&limit=100` | 历史可见事件，按原生序号向前分页 |
| PUT | `/session` | 选择当前会话，JSON：`{"sessionId":"..."}` |
| POST | `/turns` | 上传原始录音并接收本轮 NDJSON 流 |
| DELETE | `/turns/:requestId` | 取消本设备对应的进行中请求 |

每个设备独立选择当前工作区，每条设备与工作区关联独立保存会话选择。切换工作区会恢复该工作区上次选中的会话；首次进入时 `sessionId` 为 `null`，需要先选择会话。不能使用其他工作区的会话 ID，需先切换到对应的已授权工作区。设备接口不能增加工作区授权。

`/workspaces` 的 `items` 为 `{id, title, path, sessionId, ready}`；`ready` 为 `{asr: boolean, tts: boolean, summary: "configured" | "session"}`，`tts` 还要求设备已选择音色。`/me` 返回 `{protocol: 2, deviceId, name, voiceId, voices, workspaceId, workspace, workspaces, sessionId, ready}`，其中 `voiceId` 为所选音色 ID 或 `null`，`voices` 为完整共享库 `[{id,name,value}]`，`workspaces` 与 `/workspaces` 的 `items` 相同，`workspace` 为当前项或 `null`。

客户端从音色列表中选择一项，将其 `id`（不是 `value`）提交到 `PUT /voice`；插件保存选择，重新连接或插件重启后仍通过 `/me` 和 `/voices` 返回。每次查询返回当前完整列表，不按工作区过滤，音色须受设备最终采用的 TTS 服务支持。设备只能设置自身选择，不能指定其他设备 ID 或增删改音色库。刚配对的设备没有默认音色；无需工作区授权即可查看和选择音色。删除音色会将引用它的设备选择清空为 `null`；已开始的语音请求继续使用开始时的音色，下一轮才采用新的选择。客户端应等待选择接口成功后再提交录音。

当前工作区被移除或解除关联时，当前选择清空，客户端需调用 `PUT /workspace` 重新选择。无任何关联时仍可查询 `/me` 和 `/workspaces`，但无法查询会话或发起语音。首版没有设备侧新建、重命名、删除会话接口，先在 DSH 中创建会话。

会话列表采用 DSH `SessionSummary` 数据，包含 `sessionId`、`updatedAt`、`running`、`blank` 及可用的 `projections` 等。原生子代理会话不作为可选会话返回。

历史响应：

```json
{"workspaceId":"...","sessionId":"...","items":[],"hasMore":false,"before":null}
```

首次不传 `before`，默认返回最近 100 个可见事件；`limit` 范围 1–500。下一页使用本页返回的 `before`。`items` 按原始顺序排列；分页单位是事件而非完整轮次。

可见事件范围：`turn/start`、`turn/end`、`user/message`、`assistant/message`、`tool/call`、`tool/result`、`deliverables/presented`。事件结构随已验证的 DSH 版本；不返回模型隐藏推理或提供方重放状态。不保证每轮都有上述所有事件。

## 3. 提交语音

```http
POST /voxchat/api/turns
Authorization: Bearer <device-token>
Content-Type: audio/wav
X-Request-Id: <本轮唯一ID>

<原始音频字节>
```

请求体不是 multipart，也不是 JSON。允许的 Content-Type：`audio/wav`、`audio/x-wav`、`audio/mpeg`、`audio/mp3`、`audio/mp4`、`audio/webm`、`audio/ogg`、`audio/flac`。底层 ASR 服务必须支持对应编码。录音最大 25 MiB，上传时限 60 秒，不支持压缩请求体。

`X-Request-Id` 必填，格式 `[a-zA-Z0-9_-]{1,128}`，建议 UUID。每设备的请求 ID 持久化去重；已受理请求即使后来失败或中断，也不能重复执行。断线后先检查会话记录，不要自动使用新 ID 重发原指令。

请求使用提交时该设备选定的工作区、会话和模型配置，中途切换不会改变本轮归属。客户端应等待工作区选择成功再提交会话选择或录音。一个设备或一个会话已有任务时返回 `409 SESSION_BUSY`；原生 DSH 忙碌同样拒绝。不同设备可以同时使用不同会话。

## 4. 流式响应

成功进入处理阶段后：`200 application/x-ndjson; charset=utf-8`。按 UTF-8 增量解码，以换行分隔 JSON 对象，不能假设网络分块恰好对应一条消息。反向代理应关闭该接口的响应缓冲，并允许最长 10 分钟的请求。

正常帧公共字段：

```json
{"protocol":2,"requestId":"...","workspaceId":"...","sessionId":"...","seq":0,"type":"phase","data":{"phase":"asr"}}
```

| type | data | 用途 |
| --- | --- | --- |
| `phase` | `{phase: "asr" / "dsh" / "summary" / "tts"}` | 当前阶段 |
| `transcript` | `{text}` | ASR 最终转写 |
| `dsh.event` | DSH 可见原生事件 | 本轮过程与响应内容 |
| `reply` | `{text}` | DSH 完整最终文字回复 |
| `speech.text` | `{text}` | 实际送入 TTS 的完整播报稿 |
| `audio.start` | `{format, mime}` | 开始音频流，PCM 另含采样参数 |
| `audio.chunk` | `{index, data}` | Base64 编码的连续音频字节 |
| `audio.end` | `{chunks, bytes}` | 音频字节发送结束 |
| `complete` | `{status: "audio_delivered"}` | 本轮成功交付 |

`seq` 从 0 递增；音频 `index` 也从 0 递增。每个音频块不是独立音频文件，客户端应解码 Base64 后，按序输入同一音频解码器。无需等整段音频生成完毕再接收；底层服务必须实际支持流式输出才会降低首包延迟。

默认 MP3；还支持配置 opus、aac、flac、wav、pcm。PCM 协议为 24 kHz、单声道、16 位有符号小端，必须与所配置的兼容服务一致。WAV 等容器能否增量播放取决于客户端解码实现，移动端需进行实际联调。

客户端收到 `audio.start` 后准备播放，持续追加音频块。`audio.end` 不能代替 `complete`；流中断或出现 `error` 时应标记未完整交付。`complete` 只表示服务端已发送，不代表实际播放完毕。

## 5. 错误与取消

流开始前：标准 HTTP 错误和 JSON：

```json
{"error":{"code":"VOICE_NOT_CONFIGURED","message":"请先完成插件级 ASR 和 TTS 配置"}}
```

流开始后：以 `error` 帧结束，不会再发 `complete`：

```json
{"protocol":2,"requestId":"...","workspaceId":"...","sessionId":"...","seq":8,"type":"error","phase":"tts","error":{"code":"PROVIDER_ERROR","message":"模型服务返回 HTTP 503"}}
```

常见错误：

| HTTP / code | 含义 |
| --- | --- |
| 401 `UNAUTHORIZED` / `DEVICE_REVOKED` | 凭证无效或设备已撤销 |
| 503 `CONNECTION_NOT_READY` | 连接入口未就绪或隧道失败，在 DSH 设置中查看状态 |
| 401 `INVALID_PAIRING_CODE` | 配对码无效、过期或已使用 |
| 403 `WORKSPACE_FORBIDDEN` | 设备没有此工作区授权，或本轮授权已被解除 |
| 404 `SESSION_NOT_FOUND` | 会话不属于绑定工作区或不存在 |
| 409 `SESSION_BUSY` | 设备、会话或 DSH 正在处理其他请求 |
| 409 `DUPLICATE_REQUEST` | 本设备已经受理此请求 ID |
| 409 `SESSION_ARCHIVED` | 需先在 DSH 取消归档 |
| 413 `BODY_TOO_LARGE` | 上传大小超出限制 |
| 415 `AUDIO_FORMAT` | 录音 Content-Type 不支持 |
| 422 `WORKSPACE_REQUIRED` | 设备尚未选择工作区，或当前工作区授权已被移除 |
| 422 `SESSION_REQUIRED` | 设备尚未选择会话 |
| 422 `VOICE_NOT_CONFIGURED` | 插件级或有效 ASR/TTS 配置缺失 |
| 422 `DEVICE_VOICE_REQUIRED` | 设备尚未选择音色，或已移除原音色 |
| 422 `VOICE_NOT_FOUND` | 提交的音色已不存在，需刷新列表后重新选择 |
| 422 `EMPTY_TRANSCRIPT` | 未识别到有效语音 |
| 429 `RATE_LIMIT` | 配对请求过于频繁 |
| 502 `PROVIDER_ERROR` / `SUMMARY_FAILED` / `DSH_TURN_FAILED` | 对应处理阶段失败 |
| 503 `CAPACITY` | 同时进行的语音请求达到限制 |
| 504 `TURN_TIMEOUT` | 单轮超时 |

设备断开流或调用 DELETE 会停止本轮处理；撤销设备、解除本轮工作区授权、移除本轮工作区登记和插件卸载也会取消。解除其他工作区关联不影响本轮。取消只针对本轮消息，不取消其他设备或 DSH UI 的无关任务。已经产生的 DSH 原文不会撤销；有对应授权时仍可查看历史。

首版不持久化音频或提供流重放，不自动重试 DSH 执行。播报稿过长或模型失败会明确报告，不使用截断文本伪装总结成功。

## 6. 管理端配置命令

这些方法只在 DSH 已认证 Remote 连接上调用，设备 token 不能使用。

`voxchat.view()` 返回 `revision`、脱敏默认配置、`voices`（`{id,name,value}`）、`pairingOrigin`、已登记工作区、设备、`bindings` 和可选 DSH 工作区。设备为独立对象，`voice_id` 为其选择的音色或 `null`；`bindings` 的每项为 `{device_id, workspace_id, session_id}`。视图不返回配对码原文；原文只在生成命令响应中返回。

管理视图的 `connection` 为 `{mode: "manual" | "tunnel", status: "starting" | "ready" | "error" | "stopped", origin: string | null, error: string | null}`。保存地址后异步应用，保存成功不表示隧道就绪。

`voxchat.command(command)` 使用最新 `revision` 乐观并发控制，支持单项操作及批量保存：

```json
{"action":"configure","revision":0,"deviceId":null,"kind":"asr","value":{"baseUrl":"https://example.com/v1","model":"your-model","apiKey":"your-key"}}
```

`deviceId: null` 表示插件默认配置，填写设备 ID 则配置该设备。ASR、TTS 和独立总结的 `value` 均为 `{baseUrl, model, apiKey?}`；ASR 可选 `language`，TTS 可选 `format` 和 `speed`。由设备所选音色的 `value` 填入实际 `/audio/speech` 请求的 `voice` 字段。独立总结调用 `POST /chat/completions`，不需要在 DSH 中登记提供方。

插件级 ASR/TTS 不接受 `value: null`（`422 REQUIRED_MODEL_CONFIG`）；设备可先配对，但开始语音前必须补齐两项插件级配置。插件级总结 `value: null` 表示继承当前会话模型。设备的任一能力设置为 `null` 则恢复继承插件配置，按整项能力采用“设备 → 插件 → 当前会话（仅总结）”顺序。设备配置适用于它授权的所有工作区，改变工作区或其他设备配置不影响本设备。管理视图在每台设备的 `config` 返回脱敏配置、在 `sources` 返回各项来源（`device`、`plugin`、`session` 或 `missing`）；工作区条目仅含 `id` 和 `workspace`。视图仅返回 `apiKeySet`，不返回密钥；编辑同一地址时省略 `apiKey` 保留原密钥，填写空字符串清除，换地址不会继承旧密钥。客户端 HTTP 接口不返回模型配置或密钥。

其他操作均需提供 `action` 和 `revision`：

| action | 参数 | 行为 |
| --- | --- | --- |
| `addDevice` | `{name}` | 创建尚未授权工作区的设备；返回 `{id,code,expires}`，音色由客户端选择 |
| `refreshPairing` | `{deviceId}` | 仅待配对设备可手动刷新，返回 `{id,code,expires}`；旧码立即失效 |
| `configurePairing` | `{origin}` | 保存手动 HTTP(S) origin；空字符串启动自动隧道，运行地址另存 |
| `retryTunnel` | 无 | 自动隧道失败后手动重试，异步更新连接状态，不自动生成配对码 |
| `saveVoice` | `{voiceId,name,value}` | 新建或编辑共享音色，`value` 为服务要求的音色 ID |
| `removeVoice` | `{voiceId}` | 移除音色，引用此音色的设备选择清空；进行中请求不受影响 |
| `bindDevice` | `{workspaceId, deviceId}` | 授权已有 DSH 工作区；首次授权自动登记工作区，复用设备凭证 |
| `unbindDevice` | `{workspaceId, deviceId}` | 只解除该工作区关联 |
| `revokeDevice` | `{deviceId}` | 撤销设备凭证并移除所有关联 |

创建设备仅需名称，初始工作区为 `null`。通过 `bindDevice` 授权工作区后，由客户端调用 `PUT /workspace` 选择工作区；增加授权不会自动切换当前工作区。

返回 `{accepted: true, result, view}` 或 `{accepted: false, error}`。发生 `REVISION_CONFLICT` 后刷新设置，重新确认修改；不要盲目重发旧配置。

设置页统一保存使用 `{action: "batch", revision, operations: [...]}`，`operations` 为上述单项操作（不包含 revision），最多 200 项。全部操作在一个事务内提交，任一失败则全部回滚；设备撤销引发的请求取消仅在成功提交后执行。成功时 `result` 返回按操作顺序排列的 `{action, deviceId, workspaceId, result}` 数组，新设备的配对码包含在对应的 `addDevice` 结果中。
