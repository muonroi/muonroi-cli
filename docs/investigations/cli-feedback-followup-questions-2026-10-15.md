# Follow-up for CLI prompt optimization

The established repairs are implemented: forensic failures and source provenance, bounded snapshot pagination, prepared-request component estimates, truthful rate-limit/cost guidance, consumer-repository scope, and child-instruction descriptions.

Further prompt deduplication or selective instruction loading needs evidence of which components dominate and which repeated instructions affect behavior. Do not change repository policies or remove user instructions based on the size of a capability description.

After restarting the updated CLI, send this bounded request to its active session:

> Chỉ đọc và báo cáo một lần; không spawn agent, không chạy benchmark/provider probe và không sửa repo.
>
> 1. Gọi `usage_forensics` cho đúng session hiện tại. Ghi `snapshot.until`, rồi chọn tối đa ba `prepared-request` measurement đã có: record ID, callId/stepNumber, systemChars, historyChars, toolResultsChars và toolSchemasChars. Thành phần nào lớn nhất? Tách số đo ký tự/ước lượng khỏi provider usage/cache. Nếu thiếu measurement mới hoặc không liên kết chính xác được usage với request, ghi “chưa có dữ liệu”; không tự ghép bằng timestamp hoặc đọc lại toàn bộ lịch sử để bù.
>
> 2. Trong những chỉ dẫn bạn thực sự đang nhận, nêu tối đa ba cặp lặp hoặc xung đột có ảnh hưởng đến tác vụ: nguồn từng bên, trích ngắn, phạm vi áp dụng và quyết định/tool call bị ảnh hưởng. Phân biệt chỉ dẫn CLI với policy TCIS. Cùng yêu cầu đọc code trước khi sửa không tự nó là xung đột. Nếu chưa thấy tác động thực tế sau cập nhật, ghi rõ.
>
> Kết thúc bằng hai mục: “bằng chứng đủ để đề xuất cải thiện CLI” và “chưa đo được”. Không cần hỏi xác nhận hoặc tiếp tục thêm vòng điều tra để hoàn thiện cách viết báo cáo.

These questions do not ask the child to infer provider-internal RPM/TPM/plan counters, resolve TCIS release policy, or claim exact HTTP tokenization. Those require different evidence.
