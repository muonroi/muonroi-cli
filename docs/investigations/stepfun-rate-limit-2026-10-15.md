# Điều tra StepFun 429 và độ trễ muonroi-cli — 15/10/2026

## Kết luận

**Có hai vấn đề đồng thời: StepFun thực sự trả HTTP 429; CLI có các đường chờ và hủy chưa đúng, làm một lỗi upstream nhanh biến thành chờ lâu và sinh thêm request.** Không có bằng chứng xác nhận tài khoản đã hết Credit.

Các phép thử dùng cùng credential đang cấu hình và endpoint `https://api.stepfun.ai/step_plan/v1`. Request trực tiếp bỏ qua muonroi-cli vẫn bị 429. Vì vậy CLI không tự tạo ra những HTTP 429 đã ghi nhận. Tuy nhiên, phép thử TUI thật và replay cục bộ chứng minh CLI còn chờ compaction trên đường trả lời, chia sẻ cooldown giữa các model, và có thể tiếp tục retry sau timeout của bên gọi.

Phạm vi kết luận là credential, endpoint, model và thời điểm được ghi dưới đây. Chưa xác định được quy tắc phía StepFun gây ra từng lần từ chối: response chỉ có `rate_limited`, không có quota dimension, thời gian reset hay `Retry-After`. Không kết luận lỗi toàn hệ thống StepFun, cũng không kết luận mọi request tương lai sẽ lỗi.

## 1. Điều kiện và cách kiểm soát thí nghiệm

- Windows; Bun 1.3.13; CLI package 1.9.0; AI SDK 6.0.169; OpenAI-compatible provider 2.0.42.
- Checkout HEAD: `2d33b8d9a557a8fec30ea4713d98b8469f8f5603`, có thay đổi cục bộ từ các việc trước. Các lượt native chạy source workspace, không chứng minh binary đã phát hành có cùng hành vi.
- Đọc cấu hình từ project của session `0717b08730a1`: main `step-5-preview`, worker `step-3.5-flash`; cùng provider và endpoint Step Plan.
- Credential được nạp qua env-store/keychain hiện có. Giá trị trong file cấu hình và Windows User environment đã đối chiếu khớp. Không ghi key vào báo cáo hoặc log thí nghiệm.
- Giới hạn local hiệu lực đã kiểm tra: concurrency 5, RPM 100, TPM 500.000 cho cả hai model.
- Matrix trực tiếp chạy tuần tự, mỗi request đúng một lần, không retry, nghỉ 10 giây sau mỗi lượt; prompt `Reply only OK.`, output cap 64. Đây là mẫu chẩn đoán nhỏ, không phải stress test hay ước lượng SLA.
- TUI chạy qua MCP driver thật, không mock LLM, trong thư mục/home riêng; dùng chung rate ledger với CLI thật để giữ điều phối local. Không sửa cấu hình tài khoản, file Shipd hay DB phiên gốc.
- Replay được ghi rõ là **synthetic**, dùng ledger riêng, clock tiêm vào hoặc timer thật; không tính response giả vào thống kê StepFun.

Người dùng cung cấp: Pro Active đến 18/10/2026, Credit còn 97%; ngày 14/10 có 35 calls / 0,54M Credit ở 3.5 và 196 calls / 28,27M Credit ở 5. Đây là số từ dashboard người dùng, không phải số quota được API thí nghiệm xác minh độc lập. Tổng calls trong ngày không phải RPM.

Tài liệu StepFun phân biệt Step Plan với standard API và nói bảng tier theo nạp tiền không điều khiển Step Plan. Vì vậy không thể suy từ V0 sang kết luận hết allowance của gói. [Step Plan overview](https://platform.stepfun.ai/docs/en/step-plan/overview), [Pricing and rate limits](https://platform.stepfun.ai/docs/en/guides/pricing/details).

GET `/v1/accounts` với cùng key trả 200 sau 978 ms, `type=prepaid`, `balance=18.77`, trace `b00c5253223cd80585174bb0f90fb760`. Response chỉ có thông tin balance chuẩn, không có plan quota/reset. Số balance này không thay thế phần Credit Step Plan. [Accounts API](https://platform.stepfun.ai/docs/en/api-reference/accounts/get).

## 2. Thí nghiệm live: tách HTTP upstream, SDK và CLI

### A. Gọi trực tiếp trước khi chạy matrix mở rộng

| UTC 15/10 | Đường gọi | Model | Kết quả | Thời gian tổng | X-Trace-Id |
|---|---|---|---|---:|---|
| khoảng 01:29 | fetch trực tiếp, JSON | 3.5 | 429 | 800 ms | `f8be590705c2fa9da679ac23ca1887dc` |
| 01:34:12 | CLI thật, router trước worker | 3.5 | 429 | 868 ms | `ae93dfa5b430718c2d4b6b4c8e3a9e79` |
| 01:35:53 | fetch trực tiếp, stream | 5 | 200 | 2.605 ms | `7efabd0434bfaffb041f42ed39a01543` |
| 01:36:24 | fetch trực tiếp, stream | 3.5 | 429 | 840 ms | `81c961de5af69a97961c199e6b6cb1de` |

Body lỗi điển hình:

```json
{"error":{"message":"Rate limit reached, please try again later.","type":"rate_limited"}}
```

Không có header chỉ rõ quota, reset hoặc retry. Một title request bị hủy khi dừng thử nghiệm đầu; không tính nó là thành công hoặc thất bại hoàn tất. Một invocation chẩn đoán ban đầu lỗi ở bước ghi log nên không giữ được kết quả HTTP; cũng loại khỏi mẫu có bằng chứng.

### B. Matrix mở rộng và kiểm soát wire

Bảng 16 request, trace và thời gian được sinh từ JSON ở cuối báo cáo. Kết quả:

- `step-5-preview`: **4/4 HTTP 200** trong matrix mở rộng.
- `step-3.5-flash`: **4 HTTP 200, 8 HTTP 429 trên 12 request** trong matrix mở rộng và wire-control.
- Tỉ lệ 8/12 chỉ mô tả mẫu cố định này; không phải tỉ lệ rate-limit của tài khoản hay toàn dịch vụ.
- SDK gọi 3.5 có cả 200 và 429. Direct fetch cũng có cả 200 và 429.
- Payload và các header ứng dụng nhìn thấy của một request SDK được giữ lại rồi replay bằng fetch. Cùng body/header đã có cả 200 lẫn 429. Thử bỏ header SDK, hoặc thêm `stream_options.include_usage`, cũng có cả thành công lẫn từ chối.

**Kết luận đối chứng:** chưa có bằng chứng rằng SDK, `include_usage`, hay header SDK là nguyên nhân đủ để gây lỗi. Chấp nhận/từ chối 3.5 thay đổi theo các lượt đo. Điều này không chỉ ra cơ chế nội bộ của StepFun; cần trace phía server để biết nó phụ thuộc giới hạn, định tuyến hay điều kiện nào khác. Byte/body và header đã ghi nhận không bao gồm toàn bộ trạng thái kết nối/TLS hoặc mọi hoạt động khác của tài khoản.

### C. Vì sao worker chưa spawn mà đã thấy lỗi?

Capture-only dùng MCP/TUI thật nhưng chặn request tại fetch và trả 418 **cục bộ**, không gửi upstream. Nó xác định các caller trước worker: title, sub-session-router, PIL-classifier, compaction-proposer.

Real trace có request router 3.148 byte, cap 2.048 tokens đến 3.5 và bị 429 trước khi có bất kỳ worker nào. Capture-only xác nhận caller theo system prompt; response giả bị loại khỏi thống kê live.

Main model được pin là 5 không có nghĩa mọi request phụ đều dùng 5. [orchestrator.ts:3880](../../src/orchestrator/orchestrator.ts#L3880) chờ `classifySubSessionAction`; [llm-classify.ts:816](../../src/pil/llm-classify.ts#L816) chọn model fast của provider từ catalog. Đây là routing đang được thiết kế, nhưng nó tạo dependency vào model phụ trên đường trả lời.

Vì vậy một báo cáo “spawn worker bị quota” có thể xuất hiện khi lỗi thực tế nằm ở bước chuẩn bị trước task. Trong session lịch sử `71e5c3dae670`, worker đã thực hiện hai step/sáu reads trước khi lỗi ở stream kế tiếp; không được gom hai trường hợp này thành “chưa worker nào từng chạy”.

## 3. Các vấn đề CLI đã tái hiện

### CLI-1. Timeout của compaction không dừng vòng retry bên dưới

TUI live lúc 01:48 UTC ghi nhận:

1. Compaction gửi request lúc `01:48:17.334`, nhận 429 sau 795 ms.
2. Retry tiếp lúc `01:48:22.226` và `01:48:32.108`.
3. Log `Compaction proposer stalled — bounded retry` lúc `01:48:47.339`, deadline 30.000 ms.
4. Sau timeout đó, hai request cùng SHA-256 payload được gửi lúc `01:48:50.170` và `.174`, nhận hai response 429 riêng.

Nguồn: [compaction.ts:92](../../src/orchestrator/compaction.ts#L92) tạo signal deadline dài hơn race 2 giây. Nhánh timeout gọi `cleanup()` rồi bắt đầu attempt tiếp. [llm-deadline.ts:62](../../src/utils/llm-deadline.ts#L62) chỉ clear timer và gỡ parent listener; nó không abort request. Vòng chờ bên dưới còn sống.

Replay dùng đúng các helper production với timer ngắn: race 40 ms; timed signal 80 ms; sau timeout gọi cleanup theo cùng thứ tự rồi abort parent. Kết quả: caller nhận deadline sau 56 ms; signal bên dưới vẫn chưa bị abort; retry tiếp thêm **4 lần** ở 102/210/316/437 ms và chỉ kết thúc sau 438 ms. Không có request mạng trong replay.

Đây là lỗi CLI về vòng đời request, có khả năng tăng số request sau timeout và kéo dài cooldown. Không quy tất cả 429 lịch sử cho lỗi này: direct fetch đã bị 429 độc lập.

### CLI-2. Chờ rate ledger chưa phản ứng với cancellation

Replay production `wrapModelWithGate` trên clock thật: đặt cooldown 1.500 ms, abort sau 75 ms. Lời gọi chỉ kết thúc sau 1.521 ms; underlying transport vẫn được gọi khi signal đã aborted.

[model-gate.ts:409](../../src/providers/model-gate.ts#L409) chuyển signal cho retry wrapper, nhưng `paceCall` không nhận signal. [model-gate.ts:532](../../src/providers/model-gate.ts#L532) và [rate-ledger.ts:374](../../src/providers/rate-ledger.ts#L374) chờ slot/cooldown trước khi gọi transport. Kết quả cho thấy deadline/hủy không cắt ngắn bước chờ này.

Đây là lỗi cancellation local đã chứng minh, không phải thời gian xử lý inference của StepFun.

### CLI-3. Một model bị từ chối làm các model cùng provider chờ

Replay production ledger với V0 5/100/500.000, private directory và clock tiêm vào:

| Tình huống | Chờ virtual |
|---|---:|
| Model khác, cùng provider, trước khi có lỗi | 0 ms |
| Model khác, cùng provider, sau cooldown 6 giây | 6.000 ms |
| Provider khác trong cùng khoảng cooldown | 0 ms |
| Cùng provider, sau khi caller gây lỗi đã hết retry budget | 6.000 ms |

Vòng retry còn publish cooldown trước khi kiểm tra proposal có vượt retry budget không: caller budget 1.000 ms từ chối chờ thêm, nhưng ledger vẫn giữ cooldown 6.000 ms. [rate-limit-backoff.ts:406](../../src/providers/rate-limit-backoff.ts#L406), [rate-ledger.ts:328](../../src/providers/rate-ledger.ts#L328).

Chia sẻ theo provider là chính sách bảo thủ có chủ đích, không tự nó chứng minh thiết kế sai cho mọi provider. Nhưng tác động chờ qua model đã được đo; trong sample live, 5 được chấp nhận ở các đối chứng còn 3.5 bị từ chối nhiều lượt. Cần xác nhận scope limit thực từ StepFun trước khi thay cách chia budget, tránh chuyển lỗi sang request burst.

### CLI-4. Thông báo lỗi khẳng định quá mức và làm khó truy vết

[rate-limit-backoff.ts:259](../../src/providers/rate-limit-backoff.ts#L259) tự thêm câu `The limit is the account's budget, shared by every muonroi agent on this machine`. Response gốc chỉ nói rate limited. Replay phân loại chính error đó: `isQuotaExhaustion=false`, nhưng wrapper vẫn thêm câu budget.

Ngoài ra `ProviderRateLimitError` giữ body/header trong `cause`; wrapper ngoài chỉ có status 429. Replay xác nhận `outerHeaders=null`, `outerBody=null`, trong khi `cause` còn trace và body. [stream-runner.ts:1357](../../src/orchestrator/stream-runner.ts#L1357) đọc `responseBody` ở outer error và không log trace header, nên log task mất thông tin cần cho StepFun.

Không phải dữ liệu gốc bị xóa: nó còn trong `cause`. Vấn đề nằm ở cách chọn field để báo/log.

### CLI-5. Đường trả lời chờ công việc phụ và có nhiều tầng retry

Session `5aaaa73e8b1c` có ba lần từ user prompt đến `stream_start` là **61,206 / 61,044 / 62,308 giây**. Các tool được ghi trong cùng phiên mất 0,037–0,943 giây. Debug log ghi compaction timeout hai lượt × 30 giây ngay trước main stream. Lượt live mới cũng ghi timeout compaction 2 × 30 giây. Vì vậy có một nguồn trễ cụ thể ở pre-stream CLI, độc lập với duration của tool.

[orchestrator.ts:2191](../../src/orchestrator/orchestrator.ts#L2191) await proposer; [compaction.ts:45](../../src/orchestrator/compaction.ts#L45) mặc định 30 giây × 2; retry provider mặc định tổng budget 240 giây ở [rate-limit-backoff.ts:48](../../src/providers/rate-limit-backoff.ts#L48). Đây là cơ chế có thể giải thích việc một response 429 dưới một giây trở thành nhiều phút chờ.

Replay SDK với fetch giả: default SDK thực hiện 3 request trong 6.027 ms; `maxRetries=0` thực hiện 1. Tuy nhiên với `ProviderRateLimitError` đã exhausted, default SDK chỉ gọi underlying 1 lần. **Không có bằng chứng rằng mọi call đang nhân 3 thêm sau một full provider retry budget.** Cần phân biệt retry chưa được gate xử lý và lỗi đã exhausted.

## 4. Diễn giải đúng quota và nguyên nhân upstream

- 97% Credit còn lại không chứng minh mọi request phải thành công, nhưng không hỗ trợ kết luận “đã cạn Credit”.
- Bảng V0 khớp config local, song không mô tả đủ chính sách của endpoint Step Plan. Không có phép thử cố tình vượt concurrency/RPM/TPM trong matrix tuần tự.
- 429 direct đi thẳng tới domain StepFun; không gọi FastAPI catalog của muonroi. Vì thế deploy catalog không thể sửa chính response direct đã ghi nhận. Điều này không thay thế kiểm tra health/revision của mọi dịch vụ khác.
- Tại một snapshot local trước phép thử: ledger không có in-flight/cooldown, OS inventory không có background worker. Chỉ chứng minh máy đã kiểm tra; không chứng minh mọi thiết bị hoặc client cùng credential đều rảnh.
- Key được chấp nhận bởi chat 200 và accounts 200. Không có bằng chứng key sai là nguyên nhân trong các mẫu này.
- API không trả dimension của limit. Chưa thể kết luận chính xác là model capacity, quyền/tài khoản, cửa sổ giới hạn hay cơ chế khác. Tài liệu error code cũng không biến generic 429 thành chứng cứ hết allowance. [Error codes](https://platform.stepfun.ai/docs/en/api-reference/error-codes).

StepFun có thể tra một cặp cùng model/body/header: failure `16a365b6a853794e33cf2a66abd21a16` lúc 01:46:24 UTC và success `c5f1277333db037f6e4ab33a844717a9` lúc 01:46:35 UTC. [Report hỗ trợ hiện tại](./stepfun-rate-limit-2026-10-15/support-report.md) đã chuẩn bị, chưa gửi ra ngoài. Bản `support-report-initial.md` là snapshot trước matrix mở rộng, không thay thế kết luận cập nhật. [Troubleshooting và trace ID](https://platform.stepfun.ai/docs/en/guides/developer/troubleshooting).

## 5. Thứ tự xử lý có cơ sở

1. Sửa ownership/cancellation của request compaction: timeout phải hủy vòng retry cũ trước attempt mới; chứng minh không còn request sau deadline/cancel.
2. Cho bước chờ local/ledger phản ứng với abort; kiểm thử không gọi transport sau khi đã hủy và không để rơi lease.
3. Tách rõ kết luận “429 chưa rõ scope” với “hết Credit”; log status, body và trace từ cause chain, kèm caller stage thật thay `unattributed` khi biết caller.
4. Xem lại ngân sách chờ cho preflight phụ trên đường trả lời, với số đo first-response và model phụ lỗi. Việc sửa latency compaction chưa thực hiện trong đợt chẩn đoán này.
5. Xác nhận policy server từ trace trước khi đổi scope cooldown hoặc tự đổi model worker. Không tắt pacing để che lỗi và không chuyển sang endpoint standard API có tính phí riêng.

Chưa có thay đổi production mới cho đợt mở rộng chẩn đoán này; các sửa TUI/task/export từ trước được giữ nguyên. Chưa commit/push và chưa kết luận lỗi quota upstream đã được sửa. Worker end-to-end với original model chưa được chứng minh ổn định.

## 6. Tái hiện và bằng chứng

Chạy từ `D:\sources\Core\muonroi-cli`; script diagnostic nằm trong `.scratch/stepfun-boundary/` của workspace hiện tại:

```powershell
bun run .scratch/stepfun-boundary/expanded-matrix.ts
bun run .scratch/stepfun-boundary/wire-control.ts
bun run .scratch/stepfun-boundary/local-replay.ts
bun run .scratch/stepfun-boundary/abort-replay.ts
bun run .scratch/stepfun-boundary/deadline-replay.ts
bun run .scratch/stepfun-boundary/check-evidence.ts
bun run .scratch/stepfun-boundary/verify.ts --latency-only
```

Các lệnh matrix/wire/native gọi API thật và dùng allowance hiện có. Replay/check không gọi chat API. `check-evidence.ts` kiểm tra fixture của lần đo này theo filename timestamp cố định; khi tạo lần đo mới phải chọn đúng file mới trước khi diễn giải.

Kiểm thử hiện có đã chạy: `bunx vitest run src/providers/__tests__/rate-limit-backoff.test.ts src/providers/__tests__/rate-ledger.test.ts src/providers/model-gate.test.ts src/providers/__tests__/streamed-generate.test.ts`: **4 files / 86 passed, native exit 0**. Có warning Vitest về mock `bun:sqlite` từ setup chung. Kết quả này chứng minh suite hiện tại xanh; không chứng minh các lỗi được phát hiện đã được sửa.

JSON, trace timeline và bảng live sau đây được lưu cùng báo cáo để kết quả không phụ thuộc vào diễn giải trong chat.

## Phụ lục A. Mẫu live mở rộng — UTC 15/10/2026

- step-3.5-flash: 12 responses; 4 HTTP 200; 8 HTTP 429.
- step-5-preview: 4 responses; 4 HTTP 200; 0 HTTP 429.

| UTC | Đường gọi | Model | HTTP | Tổng ms | X-Trace-Id |
|---|---|---|---:|---:|---|
| 01:44:42.322 | direct-json | step-3.5-flash | 429 | 909 | `96a4fe7cffc7edb970c54626ee96bc67` |
| 01:44:53.246 | direct-json | step-5-preview | 200 | 1589 | `283df5ed0ce04a117e8044fdb584350e` |
| 01:45:04.836 | direct-stream | step-3.5-flash | 429 | 282 | `78f49159761b75ef3ad95a9136afb722` |
| 01:45:15.157 | direct-stream | step-5-preview | 200 | 1315 | `6a4a710e7b0578328750dde2e0dc5a94` |
| 01:45:26.503 | sdk-stream | step-3.5-flash | 200 | 1964 | `ee39c473333c566869d4c3174ddacfe5` |
| 01:45:38.492 | sdk-stream | step-5-preview | 200 | 2610 | `8c285b5b34c33a0415e7bcd9ed91cc1b` |
| 01:45:51.107 | direct-stream-repeat | step-3.5-flash | 429 | 282 | `550215c8a8de6e03ee27e811ae7da781` |
| 01:46:01.415 | direct-stream-repeat | step-5-preview | 200 | 1898 | `ec54037cccdd80a1c99ebdd89a25b7b5` |
| 01:46:24.265 | sdk-capture | step-3.5-flash | 429 | 927 | `16a365b6a853794e33cf2a66abd21a16` |
| 01:46:35.198 | replay-sdk-exact | step-3.5-flash | 200 | 2169 | `c5f1277333db037f6e4ab33a844717a9` |
| 01:46:47.365 | replay-sdk-no-sdk-headers | step-3.5-flash | 200 | 2366 | `08f33bec7aaf6f61b879d310547f1f82` |
| 01:46:59.754 | direct-include-usage | step-3.5-flash | 200 | 4279 | `d7c400fc3acbff3019411fae40d384ff` |
| 01:47:14.042 | sdk-capture | step-3.5-flash | 429 | 279 | `b780076eb3355481b90bb14772d5cea9` |
| 01:47:24.329 | replay-sdk-exact | step-3.5-flash | 429 | 349 | `620b0b9032b5ceec921ad29afe06691a` |
| 01:47:34.692 | replay-sdk-no-sdk-headers | step-3.5-flash | 429 | 283 | `2a5c5014c74bdb6b53002860a2dbb117` |
| 01:47:44.982 | direct-include-usage | step-3.5-flash | 429 | 273 | `bbd05eff3f36e4d37d0cbfcdb3863abb` |

## Phụ lục B. Lượt native cuối: thời gian và trace

- Prompt gửi: `2026-10-15T01:50:49.593Z`.
- Main fetch bắt đầu: `2026-10-15T01:52:01.360Z`: **71767 ms sau prompt**.
- Main nhận header sau **7478 ms** kể từ fetch; hoàn tất 200 lúc `2026-10-15T01:52:08.972Z`.
- Prompt đến main completion: **79379 ms**.
- Marker trả lời được tìm thấy trong assistant message đã lưu: **true**.
- Trace: 12 lần vào fetch, 11 HTTP responses, 8 HTTP 429; 0 worker. Một fetch lỗi/hủy không có HTTP response không được đếm là 429.
- Lượt native trước dừng ở khoảng 69,767 giây do marker trong prompt/title bị nhận nhầm. Thời gian đó đã loại khỏi số đo câu trả lời; chỉ dùng trace HTTP và log timeout của lượt đó. Lượt cuối kiểm tra bằng request/completion ID và DB assistant message.

| UTC | Event | Model | Caller | HTTP | Trace/error |
|---|---|---|---|---:|---|
| 01:50:49.668 | request | step-5-preview | session-title |  |  |
| 01:50:49.675 | request | step-3.5-flash | sub-session-router |  |  |
| 01:50:51.969 | response | step-3.5-flash | sub-session-router | 200 | 388a4723f429309013fa73a72eb8e13e |
| 01:50:52.149 | response | step-5-preview | session-title | 200 | f75d23ddf68295bedd799ca200603e07 |
| 01:50:52.712 | complete | step-3.5-flash | sub-session-router | 200 |  |
| 01:50:52.794 | complete | step-5-preview | session-title | 200 |  |
| 01:50:52.893 | request | step-3.5-flash | PIL-classifier |  |  |
| 01:50:52.945 | request | step-3.5-flash | compaction-proposer |  |  |
| 01:50:53.169 | response | step-3.5-flash | PIL-classifier | 429 | e492449ad108b00917502f0588101a51 |
| 01:50:53.169 | complete | step-3.5-flash | PIL-classifier | 429 | {"message":"Rate limit reached, please try again later.","type":"rate_limited"} |
| 01:50:53.214 | response | step-3.5-flash | compaction-proposer | 429 | 3a0e339319fa5389a59eab09b26fa834 |
| 01:50:53.215 | complete | step-3.5-flash | compaction-proposer | 429 | {"message":"Rate limit reached, please try again later.","type":"rate_limited"} |
| 01:50:57.829 | request | step-3.5-flash | PIL-classifier |  |  |
| 01:50:57.830 | fetch_error | step-3.5-flash | PIL-classifier |  | PilTimeoutError: PIL automated preparation exceeded 1500ms deadline |
| 01:50:57.836 | request | step-3.5-flash | compaction-proposer |  |  |
| 01:50:58.112 | response | step-3.5-flash | compaction-proposer | 429 | 3865a3fbd57609d181893f42f0f8bd41 |
| 01:50:58.113 | complete | step-3.5-flash | compaction-proposer | 429 | {"message":"Rate limit reached, please try again later.","type":"rate_limited"} |
| 01:51:06.999 | request | step-3.5-flash | compaction-proposer |  |  |
| 01:51:07.276 | response | step-3.5-flash | compaction-proposer | 429 | 0edff54be7d58113a94079182c3f420b |
| 01:51:07.277 | complete | step-3.5-flash | compaction-proposer | 429 | {"message":"Rate limit reached, please try again later.","type":"rate_limited"} |
| 01:51:25.988 | request | step-3.5-flash | compaction-proposer |  |  |
| 01:51:25.991 | request | step-3.5-flash | compaction-proposer |  |  |
| 01:51:26.795 | response | step-3.5-flash | compaction-proposer | 429 | a2194ea5579d67664fb200c2ccc922f9 |
| 01:51:26.795 | complete | step-3.5-flash | compaction-proposer | 429 | {"message":"Rate limit reached, please try again later.","type":"rate_limited"} |
| 01:51:26.797 | response | step-3.5-flash | compaction-proposer | 429 | 173616095fbe9aa3e508b134a2aefc83 |
| 01:51:26.797 | complete | step-3.5-flash | compaction-proposer | 429 | {"message":"Rate limit reached, please try again later.","type":"rate_limited"} |
| 01:52:01.360 | request | step-5-preview | other |  |  |
| 01:52:01.364 | request | step-3.5-flash | compaction-proposer |  |  |
| 01:52:01.370 | request | step-3.5-flash | compaction-proposer |  |  |
| 01:52:02.242 | response | step-3.5-flash | compaction-proposer | 429 | e0b1de867d612b1e883ba57f115455f4 |
| 01:52:02.243 | complete | step-3.5-flash | compaction-proposer | 429 | {"message":"Rate limit reached, please try again later.","type":"rate_limited"} |
| 01:52:02.244 | response | step-3.5-flash | compaction-proposer | 429 | dc52e46cf9cd7e4a0610f07783a8e07f |
| 01:52:02.244 | complete | step-3.5-flash | compaction-proposer | 429 | {"message":"Rate limit reached, please try again later.","type":"rate_limited"} |
| 01:52:08.837 | response | step-5-preview | other | 200 | a56a009675b6a39acf2a14b02f66b100 |
| 01:52:08.972 | complete | step-5-preview | other | 200 |  |

## Phụ lục C. Files bằng chứng

[Summary](./stepfun-rate-limit-2026-10-15/summary.json), [matrix](./stepfun-rate-limit-2026-10-15/expanded-2026-10-15T01-44-42-322Z.json), [wire controls](./stepfun-rate-limit-2026-10-15/wire-control-2026-10-15T01-46-24-265Z.json), [native timeline](./stepfun-rate-limit-2026-10-15/native-latency.json), [native pre-worker](./stepfun-rate-limit-2026-10-15/native-preworker.json), [replay ledger/SDK](./stepfun-rate-limit-2026-10-15/local-replay-result.json), [replay abort](./stepfun-rate-limit-2026-10-15/abort-replay-result.json), [replay deadline](./stepfun-rate-limit-2026-10-15/deadline-replay-result.json), [historical latency](./stepfun-rate-limit-2026-10-15/historical-latency.json), [test log](./stepfun-rate-limit-2026-10-15/focused-tests.log).
