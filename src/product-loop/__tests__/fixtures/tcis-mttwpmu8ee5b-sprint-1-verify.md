# Sprint 1 verify — FAIL (score 0.00)

```
[verify-floor] Deterministic verify floor FAILED — the project's own gates did not pass.
- [build] `dotnet build "src\TCISLibraries.sln" --no-restore` → OK (32733ms)
- [test] `dotnet test "src\TCISLibraries.sln" --no-build --nologo` → EXIT 1 (13673ms)

First failing command output (tail):
```
…(truncated 62388 chars)…
ts.UnknownSchema_FailsLoudly_AtQueryTime [FAIL]
[xUnit.net 00:00:02.91]     TCIS.Pluggable.Persistence.PostgreSql.IntegrationTests.T2_SchemaIsolationTests.TenantSchemaWins_OverFallbackSchema [FAIL]
[xUnit.net 00:00:02.91]     TCIS.Pluggable.Persistence.PostgreSql.IntegrationTests.T2_SchemaIsolationTests.GuidAsSchemaName_IsRejected_ProvingIdentifierIsRequired [FAIL]
[xUnit.net 00:00:02.91]     TCIS.Pluggable.Persistence.PostgreSql.IntegrationTests.T2_SchemaIsolationTests.ReopeningConnection_ReappliesSchema [FAIL]
[xUnit.net 00:00:02.91]     TCIS.Pluggable.Persistence.PostgreSql.IntegrationTests.T2_SchemaIsolationTests.InjectionPayloadInFallbackSchema_IsRejectedAtConstruction(payload: "public; DROP TABLE gate_transactions;--") [FAIL]
[xUnit.net 00:00:02.91]     TCIS.Pluggable.Persistence.PostgreSql.IntegrationTests.T2_SchemaIsolationTests.InjectionPayloadInFallbackSchema_IsRejectedAtConstruction(payload: "a\"b") [FAIL]
[xUnit.net 00:00:02.91]     TCIS.Pluggable.Persistence.PostgreSql.IntegrationTests.T2_SchemaIsolationTests.TenantSchemaMissingTable_FailsLoudly_InsteadOfReadingAnotherSchema [FAIL]
[xUnit.net 00:00:02.91]     TCIS.Pluggable.Persistence.PostgreSql.IntegrationTests.T2_SchemaIsolationTests.ExplicitFallbackSchema_IsUsedWhenTenantSchemaLacksTheTable [FAIL]
[xUnit.net 00:00:02.92]     TCIS.Pluggable.Persistence.PostgreSql.IntegrationTests.T2_SchemaIsolationTests.Cleanup_ResetsSearchPathBeforeReturningToPool [FAIL]
[xUnit.net 00:00:02.92]     TCIS.Pluggable.Persistence.PostgreSql.IntegrationTests.T2_SchemaIsolationTests.AlternatingTenants_NeverLeakAcrossPooledConnections [FAIL]
[xUnit.net 00:00:02.92]     TCIS.Pluggable.Persistence.PostgreSql.IntegrationTests.T2_ConcurrentAccessTests.ReadsRunInParallelWithAnOpenWriteTransaction [FAIL]
[xUnit.net 00:00:02.92]     TCIS.Pluggable.Persistence.PostgreSql.IntegrationTests.T2_ConcurrentAccessTests.ParallelReads_MixedTenants_NeverCrossContaminate [FAIL]
[xUnit.net 00:00:02.92]     TCIS.Pluggable.Persistence.PostgreSql.IntegrationTests.T2_ConcurrentAccessTests.ParallelReads_SameTenant_AllSucceed [FAIL]
[xUnit.net 00:00:02.97]     TCIS.Pluggable.Persistence.SqlServer.IntegrationTests.T1_RowLevelSecurityTests.TenantSeesOnlyItsOwnRows [FAIL]
[xUnit.net 00:00:02.98]     TCIS.Pluggable.Persistence.SqlServer.IntegrationTests.T1_RowLevelSecurityTests.WithoutTenantIdentity_SeesNothing [FAIL]
[xUnit.net 00:00:02.98]     TCIS.Pluggable.Persistence.SqlServer.IntegrationTests.T1_RowLevelSecurityTests.WritingOwnRow_Succeeds [FAIL]
[xUnit.net 00:00:02.98]     TCIS.Pluggable.Persistence.SqlServer.IntegrationTests.T1_RowLevelSecurityTests.SwitchingTenantOnReusedConnection_ChangesVisibleRows [FAIL]
[xUnit.net 00:00:02.98]     TCIS.Pluggable.Persistence.SqlServer.IntegrationTests.T1_RowLevelSecurityTests.RawSqlReadPath_IsProtectedOnlyByRls [FAIL]
[xUnit.net 00:00:02.98]     TCIS.Pluggable.Persistence.SqlServer.IntegrationTests.T1_RowLevelSecurityTests.ApplicationAccount_CannotDisableThePolicy [FAIL]
[xUnit.net 00:00:02.98]     TCIS.Pluggable.Persistence.SqlServer.IntegrationTests.T1_RowLevelSecurityTests.WritingAnotherTenantsRow_IsBlockedByDatabase [FAIL]
[xUnit.net 00:00:01.31]     TCIS.EventBus.Kafka.IntegrationTests.KafkaReceivePathIntegrationTests.Payload_not_matching_dto_is_logged_as_error_with_a_traceable_id [FAIL]
[xUnit.net 00:00:01.32]     TCIS.EventBus.Kafka.IntegrationTests.KafkaReceivePathIntegrationTests.Configured_group_id_is_the_one_that_commits_offsets_on_the_broker [FAIL]
[xUnit.net 00:00:01.33]     TCIS.EventBus.Kafka.IntegrationTests.KafkaReceivePathIntegrationTests.Poison_message_does_not_block_the_next_valid_message [FAIL]
[xUnit.net 00:00:01.33]     TCIS.EventBus.Kafka.IntegrationTests.KafkaReceivePathIntegrationTests.Publish_and_consume_round_trip_through_a_real_broker [FAIL]
[xUnit.net 00:00:01.33]     TCIS.EventBus.Kafka.IntegrationTests.KafkaReceivePathIntegrationTests.Third_party_message_without_tcis_headers_is_parked_logged_and_committed [FAIL]
```
```
