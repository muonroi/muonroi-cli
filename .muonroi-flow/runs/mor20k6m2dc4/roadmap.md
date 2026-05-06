## Council Update

Plan refactor orchestrator.ts được điều chỉnh dựa trên thảo luận: giữ nguyên processMessage làm generator điều phối; tách module theo thứ tự ưu tiên tool-executor → observer-pipeline → stream-engine; sử dụng ProcessingContext immutable; thêm ProviderGateway mỏng; compaction tách policy (session) và execution (CompactionEngine); session quản lý messages với cơ chế đồng bộ và bất đồng bộ; thêm characterization tests và MetricsCollector. Lộ trình 3 tuần, bắt đầu bằng characterization tests.
