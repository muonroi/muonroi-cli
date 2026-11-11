# Brief cho session CLI mới: kiểm chứng progressive task context

Đây là các điểm còn cần quan sát với model thật, không phải yêu cầu đọc source hay sửa CLI. Bản triển khai cơ chế đã có test/mock; chưa có phép đo chứng minh model tự chọn context đúng hoặc tổng tiền/độ trễ giảm. Không cần gửi API key.

Có thể copy phần dưới vào session mới sau khi khởi động lại CLI/MCP:

---

Bạn đang chạy bên trong muonroi-cli vừa cập nhật progressive task context. Hãy đánh giá bằng runtime của tác vụ thực tế tôi giao. Giữ model/provider, quyền và cấu hình hiện tại. Phân biệt hành vi tự nhiên của bạn với một thí nghiệm được chủ động tạo ra; không dùng mô tả capability làm bằng chứng rằng hành vi đã xảy ra.

1. **Chọn context có tự nhiên không?** `context_load` có sẵn không? Trong tác vụ vừa làm, bạn có cần gói research/plan/implement/verify nào, đã gọi đổi stage lúc nào? Ghi session, toolCallId, stage và revision. Nếu không gọi, lý do cụ thể là đủ hướng dẫn ở nền hay không nhận ra cơ chế? Đừng gọi thêm chỉ để tạo số liệu đẹp.

2. **Khám phá skill có làm tăng lượt không?** Với skill user yêu cầu hoặc repo bắt buộc, index rút gọn có đủ để nhận diện không? Có lấy được metadata/path đầy đủ bằng `context_load(topic="skills", query=...)`, rồi đọc SKILL.md không? Có lượt gọi thêm, query trượt hay skill bị bỏ sót nào? Trả nguyên input và lỗi liên quan, không suy ra từ danh sách tool.

3. **Bàn giao có đủ để tiếp tục?** Nếu phiên thực tế có compaction/resume hoặc user nhắn “tiếp tục”, stage/revision và quyết định/blocker/bằng chứng quan trọng còn dùng được không? Có bị quay về orient hoặc dùng nhầm stage của việc khác không? Chỉ ra thông tin nào thiếu, stub cụ thể và tool_call_id đã thử retrieve. Không gọi một bằng chứng mất là “đã bảo toàn”.

4. **Quy tắc repo và quyền có bị hiểu sai?** Nêu một quyết định thực tế liên quan quyền hoặc workflow. Stage implement/verify có bị hiểu là đã được duyệt plan hoặc được quyền chạy shell không? Có guideline luôn áp dụng nào bị thiếu? Nêu nguồn và tình huống thật; không tự loại hay thay quy tắc repo.

5. **Tổng chi phí và thời gian ra sao?** Lấy snapshot `usage_forensics` cho đúng session/family và `snapshot.until`. Ghi prepared-request theo callId/stepNumber: contextStage, revision, taskContextChars, taskHandoffChars và các system*Chars có sẵn; số request, usage/cache/cost ước lượng và thời gian đo được. Chú ý: các số context/handoff/system-section là thành phần con, không cộng lại vào input. Chi phí lưu trong CLI không phải hóa đơn provider. Nếu không có baseline cùng tác vụ/model/cache, chỉ báo số đã đo, chưa kết luận rẻ/nhanh hơn.

6. **Main và child có giúp nhau không?** Nếu tác vụ đã có worker thật, parent/child có stage độc lập và receipt/bằng chứng truy xuất được không? Khi callback về, main có giữ mục tiêu và xử lý đúng phiên bản kết quả không? Nếu không có worker, ghi chưa đo; không spawn chỉ để trả lời câu này.

Kết quả mong muốn: tối đa ba friction thực sự ảnh hưởng công việc, mỗi cái kèm session/record/toolCallId, input/output liên quan, việc phải làm thêm và tác động quan sát được. Những điều không có bằng chứng ghi “chưa đo”.

---

## Quyết định sản phẩm để bàn sau khi có dữ liệu

- Nếu tra skill tạo quá nhiều lượt, nên hiển thị đường dẫn rút gọn có root alias ngay trong index hay giữ tra cứu metadata theo nhu cầu? Hiện ưu tiên tên đầy đủ + mô tả ngắn, có đường lấy metadata/path đầy đủ.
- Có cần mở rộng phục hồi stage sang session rotation hoặc câu tiếp tục dài/tự nhiên hơn không? Hiện chỉ phục hồi trong đúng session/cwd, qua chuỗi continuation được bộ nhận diện sẵn có xác nhận; công việc khác là ranh giới dừng.
- Có đủ bằng chứng để thu hẹp tool schemas theo stage không? Hiện giữ các tool/grant cũ và thêm loader đọc; chưa áp activeTools filtering để tránh làm mất capability cần dùng.
- Batch API cần ưu tiên hỗ trợ không? Source hiện có các stub ném lỗi “Batch API not available in Phase 0”; không có đường batch thực tế để xác nhận per-submit projection. Không coi batch là đã được nghiệm thu.

Các câu hỏi này không chặn phần cơ chế đã kiểm chứng. Giữ các kết quả mock/compiled riêng với kết quả session dùng provider thật.
