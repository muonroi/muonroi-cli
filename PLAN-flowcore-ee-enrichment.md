# PLAN: Background Enrichment cho EE dùng Flowcore (Trusted Sources như Context7)

## Updated Phase 1 Curated Sources (synthesized from multi-perspective sub-agent analysis)

**Ecosystem (Muonroi/BB authoritative — high trust 0.95–0.99)** — start here (from ecosystem specialist sub-agent):
1. `muonroi-bb-core` — README, REPO_DEEP_MAP, OSS-BOUNDARY, samples/*, src/*/README (GitHub raw + tree)
2. `muonroi-official-ref-docs` — muonroi-docs repo + rendered docs.muonroi.com (BB packages, recipes, guides, tenancy, rule-engine)
3. `muonroi-bb-templates` — the three template repos (Base/Modular/Microservices) + .template.config + README
4. `muonroi-rule-engine` — rule-engine packages + samples + docs
5. `muonroi-multi-tenancy` — tenancy packages + guides
6. `muonroi-foundation-ecosystem` — foundation packages + setup recipes (Core, Observability, etc.)

**External (scoped 3rd-party library docs — medium-high trust 0.88–0.95, like targeted Context7)** (from external specialist sub-agent):
1. `aspnet-minimal-apis` (MS Learn, weekly)
2. `ef-core` (MS Learn + EF docs, weekly)
3. `mediatr` (official wiki + repo, monthly)
4. `fluentvalidation` (official docs, monthly)
5. `serilog` (wiki, monthly)
6. `opentelemetry-dotnet` (MS Learn + contrib, weekly)
7. `aspnet-jwt-bearer` (MS Learn)
8. `aspnet-distributed-caching-redis` (MS Learn)

**Crawler/Infra perspective** (from flowcore specialist): Start with GitHub raw + tree adapters for Muonroi repos (high control, version via tags/sha). For MS Learn use web harvester with version-param URLs. Add generic docs adapter that does heading-aware chunking + code block preservation. Manifest-driven, state for incremental (etag/blob_sha per path/ref).

**EE/Retrieval perspective** (from EE specialist): Use collection `"ecosystem"` for Muonroi/BB and `"external"` for libraries. Payload must carry `source_id`, `type`, `trust`, `crawled_at`, `url`, `version`. Emit markers `<!-- ecosystem:<id>:<sha16> -->` and `<!-- external:<id>:<sha16> -->`. Extend `ee_query` / Layer 3 / bb-retrieval to filter or boost by collection + trust. Keep ingestion via existing `/api/ingest-point` contract.

Start Phase 1 with the top 3 ecosystem + top 2 external. All entries go into `docs-catalog/manifest.json` (or split). Use collection `"ecosystem"` or `"external"`.

Every point written to EE must include:
```json
{
  "source_id": "...",
  "type": "ecosystem" | "external",
  "trust": 0.XX,
  "crawled_at": "...",
  "url": "...",
  "version": "...",
  "domain": "..."
}
```

Add markers in text for dedup:
`<!-- ecosystem:muonroi-bb-recipes:<sha16> -->`
`<!-- external:ef-core:<sha16> -->`

## Phase 0 (unchanged, do first)
See original below.


## Mục tiêu tổng thể
- Dùng flowcore infra (crawler mạnh, anti-bot) chạy **background jobs** để crawl dữ liệu tĩnh/semi-tĩnh.
- Làm giàu EE (Experience Engine) thành "nguồn trust" chất lượng cao.
- Phân tách rõ:
  - `ecosystem`: Thông tin Muonroi / BB / recipes / templates / principles (nội bộ).
  - `external`: Thư viện/framework bên ngoài (library docs, patterns) — giống Context7 nhưng scoped.
- Agent sau này dùng `ee_query` + Layer 3 injection để lấy dữ liệu chất lượng cao, version-aware, fresh.
- Không crawl vô hạn: Dùng **curated manifest** (danh sách nguồn có kiểm soát).

## Nguyên tắc
- Bắt đầu **rất nhỏ** (5-10 nguồn quan trọng nhất).
- Ưu tiên dữ liệu tĩnh → job định kỳ (daily/weekly).
- Luôn gắn metadata: `source`, `version`, `crawled_at`, `trust_score`, `url`.
- Dùng marker `<!-- source:ecosystem|external -->` hoặc tương tự để dedup ở EE.
- Tận dụng flowcore hiện có (harvester, state, enrichment).
- Sau này mới thêm on-demand MCP nếu cần.

---

## Phase 0: Truy cập & Deploy Flowcore trên VPS (Bước đầu tiên)

### 0.1 Chuẩn bị local
- Clone/update source flowcore tại `D:\sources\Core\tmp\flowcore` (nếu chưa có).
- Đảm bảo key SSH: `C:\Users\phila\.ssh\muonroi_vps_rsa`

### 0.2 SSH vào VPS
```powershell
ssh -i C:\Users\phila\.ssh\muonroi_vps_rsa phila@72.61.127.154
```

Sau khi vào:
```bash
cd /path/to/flowcore   # ví dụ ~/flowcore hoặc /opt/flowcore (kiểm tra bằng `ls`)
docker ps | grep flowcore   # kiểm tra service đang chạy
```

### 0.3 Kiểm tra trạng thái hiện tại
```bash
docker compose ps
docker logs flowcore-harvester --tail 50
# hoặc
docker compose logs --tail 100 | grep -E "(harvester|worker)"
```

### 0.4 Nếu cần upgrade flowcore
**Trên local (Windows):**
1. Sửa code, thêm adapter/job mới.
2. Test local nếu có thể (`docker compose up`).
3. Commit + push:
   ```powershell
   git add .
   git commit -m "feat(flowcore): add docs crawler job + adapters for ecosystem/external"
   git push origin main   # hoặc branch đang dùng
   ```

**Trên VPS:**
```bash
ssh -i C:\Users\phila\.ssh\muonroi_vps_rsa phila@72.61.127.154
cd /path/to/flowcore
git pull origin main
docker compose down
docker compose up -d --build
docker compose --profile manual up -d backup-worker   # nếu có
```

Kiểm tra:
```bash
docker compose ps
# Chạy thử một job nhỏ nếu có
```

**Lưu ý:** Nếu flowcore dùng Kafka/Postgres/Mongo, đảm bảo volumes và data không bị mất.

---

## Phase 1: Tạo Curated Manifest (Danh sách nguồn có kiểm soát)

**Không crawl vô hạn.** Tạo file manifest để kiểm soát.

### 1.1 Vị trí
Đề xuất tạo trong flowcore repo:
```
flowcore/
  docs-catalog/
    manifest.json
    ecosystem.json
    external.json
```

### 1.2 Cấu trúc manifest tối giản (bắt đầu)

**manifest.json**
```json
{
  "version": 1,
  "updated_at": "2026-07-02",
  "ecosystem": [
    {
      "id": "muonroi-bb-recipes",
      "name": "Muonroi Building Block Recipes & Templates",
      "type": "ecosystem",
      "sources": [
        {"url": "https://github.com/muonroi/muonroi-building-block", "doc_paths": ["docs/", "recipes/"]},
        {"url": "https://docs-mcp.muonroi.com", "type": "muonroi-official"}
      ],
      "update_frequency": "daily",
      "priority": 1,
      "trust": 0.98
    }
  ],
  "external": [
    {
      "id": "dotnet-minimal-api",
      "name": "ASP.NET Core Minimal APIs",
      "type": "external",
      "sources": [
        {"url": "https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis", "version_strategy": "doc-version"}
      ],
      "update_frequency": "weekly",
      "priority": 2,
      "trust": 0.92
    }
  ]
}
```

### 1.3 Danh sách bắt đầu đề xuất (Phase 1 - 5-7 nguồn)

**Ecosystem (ưu tiên cao nhất):**
- Muonroi BB recipes, templates, packages, setup_guide, architecture principles.
- Muonroi official docs site.
- Các repo chính của Muonroi (nếu public).

**External (bắt đầu hẹp):**
- 2-3 thư viện/framework cốt lõi hay dùng trong BB (ví dụ: Entity Framework, ASP.NET Core, một số library phổ biến).
- Official docs của .NET ecosystem.

**Quy tắc thêm nguồn sau này:**
- Chỉ thêm khi agent hay hỏi sai hoặc thiếu (dựa vào usage logs, council, ee_query logs).
- Mỗi nguồn phải có `update_frequency` + `trust` score.

---

## Phase 2: Xây Background Jobs trong Flowcore

### 2.1 Mở rộng Flowcore
- Tạo adapter mới hoặc dùng generic docs crawler.
- Vị trí đề xuất:
  ```
  src/flowcore/adapters/docs_adapter.py
  src/flowcore/jobs/docs_crawler_job.py
  ```

### 2.2 Job Flow (background)
1. Đọc `manifest.json`.
2. Với mỗi source:
   - Dùng harvester (stealth nếu cần) để fetch.
   - Parse → extract headings, code blocks, version info.
   - Chunk thông minh (giữ context code).
   - Gắn metadata:
     ```json
     {
       "source_id": "muonroi-bb-recipes",
       "type": "ecosystem",
       "version": "v2.3.1",
       "crawled_at": "2026-07-02T10:00:00Z",
       "url": "...",
       "trust": 0.98
     }
     ```
3. Lưu tạm (file hoặc DB) → push vào queue (Kafka nếu có) hoặc trực tiếp gọi ingestion.

### 2.3 Scheduling
- Dùng cron hoặc worker scheduler hiện có của flowcore.
- Ví dụ:
  - Ecosystem: hàng ngày 02:00.
  - External quan trọng: hàng tuần.
- Hỗ trợ manual trigger: `python -m flowcore.scripts.trigger_docs_crawl --source muonroi-bb-recipes --force`.

### 2.4 Files cần tạo/sửa (flowcore side)
- `src/flowcore/adapters/docs_generic.py`
- `src/flowcore/jobs/docs_ingest_job.py`
- `scripts/trigger_docs_crawl.py`
- Cập nhật `docker-compose.yml` nếu cần thêm service/job profile.
- Thêm vào `up.sh` / health check nếu cần.

---

## Phase 3: EE Ingestion & Collections

### 3.1 Collections (theo yêu cầu của bạn)
- `ecosystem`: Tất cả nội dung Muonroi / BB / recipes.
- `external`: Thư viện/framework bên ngoài.

### 3.2 Ingestion Script (có thể để trong flowcore hoặc muonroi-cli/scripts)
Ví dụ script (Python, dùng ee client):
```python
# flowcore/scripts/ingest_to_ee.py
def ingest(chunks, collection: str):
    for chunk in chunks:
        ee_write(
            text=chunk["content"],
            collection=collection,   # "ecosystem" hoặc "external"
            metadata={
                "source_id": chunk["source_id"],
                "type": "docs",
                "version": chunk.get("version"),
                "crawled_at": chunk["crawled_at"],
                "url": chunk["url"],
                "trust": chunk["trust"]
            }
        )
```

### 3.3 Marker để dedup (giống hiện tại)
Sử dụng `<!-- ecosystem:xxx -->` hoặc `<!-- external:xxx -->` + sha để Layer 3 tránh inject trùng.

### 3.4 Files liên quan (muonroi-cli side)
- `scripts/ingest-docs-to-ee.py` (mới)
- Cập nhật `src/ee/bb-retrieval.ts` nếu cần (hoặc tạo generic retrieval).
- Thêm vào existing ingestion pipeline nếu có.

---

## Phase 4: Verification & Agent Side

1. Chạy job thủ công → kiểm tra data trong EE.
2. Dùng `ee_query` test xem agent có lấy được không.
3. Thêm vào playbook/directives nếu cần nudge.
4. Cập nhật `list_mcp_servers` / introspection nếu expose sau này.
5. Monitor: log, freshness, lỗi crawl.

---

## Phase 5: Mở rộng sau (không làm ngay)

- Thêm on-demand MCP tool (nếu agent cần real-time hơn).
- Mở rộng catalog (dựa trên usage logs).
- Version pinning tốt hơn.
- Reranking / quality scoring.

---

## Checklist bắt đầu ngay

- [ ] SSH vào VPS, kiểm tra flowcore đang chạy.
- [ ] (Nếu cần) Update flowcore local → commit → push → pull + deploy trên VPS.
- [ ] Tạo thư mục `docs-catalog/` + file `manifest.json` với 3-5 nguồn ecosystem trước.
- [ ] Viết adapter/job cơ bản trong flowcore.
- [ ] Viết ingestion script đẩy vào collection `ecosystem`.
- [ ] Test end-to-end: crawl → ee_write → ee_query.
- [ ] Ghi log + freshness metadata.

## Rủi ro & Mitigation
- Crawl quá nhiều → Giới hạn bằng manifest + priority.
- Data chất lượng thấp → Bắt buộc parser tốt + manual review vài nguồn đầu.
- EE bị bloat → Dùng collection riêng + metadata filter.
- Job fail → Dùng state + retry của flowcore.

Bắt đầu từ Phase 0 + Phase 1 ngay hôm nay được không? Cần mình hỗ trợ viết manifest mẫu hoặc script đầu tiên không?
