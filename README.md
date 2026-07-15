# ES CCR Failover/Failback 자동화 웹 UI

앞서 정리한 절차서(`ccr-failover-failback-procedure.md`)를 버튼 기반 웹 UI로 옮긴 샘플 프로젝트입니다.
Node.js 백엔드가 실제로 각 Elasticsearch 클러스터에 REST 호출(curl과 동일한 내용)을 수행합니다.

## 설치

```bash
cd ccr-automation-ui
npm install
cp .env.example .env
# .env의 ENCRYPTION_KEY를 랜덤 값으로 교체
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

위에서 나온 값을 `.env`의 `ENCRYPTION_KEY=`에 붙여넣으세요.

## 실행

```bash
npm start
# http://localhost:4000 접속
```

## 화면 구성과 절차서 매핑

| 화면 섹션 | 절차서 단계 |
|---|---|
| 0. 실시간 트래픽 다이어그램 | (신규) 백엔드 → 클러스터로 실제 나가는 모든 REST 호출을 실시간으로 시각화 |
| 1. 클러스터 등록 | 사전 확인(0단계) — 주센터/DR센터 접속 정보 등록 |
| 2. CCR 연동 | 3, 4단계 — API Key 발급 → keystore 등록(수동) → remote 등록 → follower 생성 |
| 3. 샘플 벡터 인덱스 생성 (rag-vectors) | 4단계 초반 — 주신 rag-vectors 매핑/설정 그대로 반영, 배치 단위 시드 삽입 |
| 4. CCR 복제 모니터링 | 4단계 — `_ccr/stats` 폴링 |
| 5. Failover 실행 | 5단계 — pause_follow → close → unfollow → open |
| 5. Failback 마법사 | 6~8단계 — 인덱스 삭제 → 역방향 API Key/remote/follow → 동기화 확인 → 역방향 해제 |

## 우측 아키텍처 패널 (신규)

화면 우측에 스크롤해도 계속 보이는(sticky) 패널이 있습니다.

- **아키텍처 상태**: 주센터/DR센터 박스가 위아래로 표시되고, 각 박스에 연결 상태 점(초록=정상,
  빨강=실패, 회색=미확인), 현재 역할 배지(리더/팔로워/독립 인덱스/역할 미지정), Kibana 바로가기
  링크(등록했다면)가 실시간으로 반영됩니다. 두 박스 사이 화살표는 CCR 연동 방향과 상태를 그대로
  보여줍니다: 초록 실선 = 정상 복제 중, 빨간 점선 = Failover로 끊긴 상태. 실제로 어떤 액션 버튼을
  누르든(연결테스트, CCR 단계, failover/failback 등) 백엔드 → 클러스터 요청이 발생하는 순간 화살표가
  주황색으로 잠깐 반짝입니다.
- **실시간 이벤트**: 방금 무슨 요청이 어느 클러스터로 나갔는지, 성공/실패, 소요시간을 피드 형태로 보여줍니다.

이 패널의 데이터는 `GET /api/state` (클러스터 목록 + 현재 CCR 링크 상태)로 최초 로드되고, 이후로는
SSE(`/api/events/stream`)의 `state` 이벤트로 실시간 갱신됩니다. CCR 링크 상태는 `data/db.json`의
`ccrLinks` 배열에 저장되며 `server/ccrState.js`가 관리합니다 (follow 성공 시 `linked`, failover의
unfollow 성공 시 `unfollowed`로 전환).

## 툴팁 · "실제 어떤 동작이 수행되나요?"

- "5. Failover / Failback 실행" 제목 옆의 ⓘ 아이콘에 마우스를 올리면 Failover/Failback이 각각
  무슨 뜻인지 한 줄 설명이 뜹니다.
- CCR 연동, 샘플 인덱스 생성, 모니터링, Failover, Failback 각 버튼 그룹 옆에 **"실제 어떤 동작이
  수행되나요?"** 버튼이 있습니다. 누르면 그 단계에서 실제로 나가는 REST API(메서드+경로)와 각각의
  목적을 평이한 말로 풀어서 보여줍니다 (`app.js`의 `ACTION_INFO` 객체에서 관리 — 문구를 바꾸고
  싶으면 여기만 수정하면 됩니다).

## Kibana 바로가기

클러스터 등록 시 "Kibana 주소"는 선택 입력입니다. 등록해두면 클러스터 목록 카드와 우측 아키텍처
다이어그램 박스에 "Kibana 열기" 링크가 나타나서 새 탭으로 바로 이동할 수 있습니다.

## SSE 이벤트 메커니즘 (교육/시연용, 참고)

어떤 버튼을 누르든(클러스터 테스트, CCR 연동 단계, 인덱스 생성, failover/failback 등) 백엔드가
실제로 해당 클러스터에 보내는 REST 요청이 **Server-Sent Events(SSE, `/api/events/stream`)** 로
프론트엔드에 실시간 전달되어 우측 패널에 그대로 반영됩니다. 트래픽을 가로채거나 별도 저장하지 않고,
요청이 발생하는 즉시 그대로 흘려보내기만 합니다 (`server/eventBus.js` + `server/esClient.js`의
`call()`이 자동으로 `traffic` 이벤트를 emit, `server/stateBroadcast.js`가 `state` 이벤트를 emit).

## rag-vectors 인덱스 스펙

"3. 샘플 벡터 인덱스 생성" 섹션은 주신 설정을 기본값으로 그대로 사용합니다:

- 5 샤드 / 1 레플리카, `soft_deletes.enabled: true`, `refresh_interval: 30s`, `best_compression`
- `content_analyzer` (standard tokenizer + lowercase/stop/snowball)
- `embedding` 필드: `dense_vector`, dims 768(기본), HNSW(`m:16, ef_construction:200`)
- `metadata` object, `tags` keyword, `created_at` date 등 주신 필드 구조 동일

직접 만든 다른 매핑을 쓰고 싶으면 "고급: settings/mappings JSON 직접 입력"에 붙여넣으면 그걸 그대로 사용합니다.

시드 데이터는 `insert-rag-vectors-stream.py`의 메타데이터 풀(SOURCES/CATEGORIES/SECTIONS/...)을
Node로 그대로 옮겨서(`server/ragDocGenerator.js`) 비슷한 형태의 문서를 생성하고, `배치 크기` 단위로
나눠서 `_bulk`에 전송합니다 (한 번에 다 만들어서 보내지 않고 배치별로 순차 전송 — 대용량 삽입 시
메모리 문제 방지 및 다이어그램에서 배치별 요청이 하나씩 보이는 걸 확인 가능).

## 설계상 알아둘 점

1. **keystore 등록은 자동화하지 않았습니다.** `elasticsearch-keystore add` 는 각 노드의 OS 셸 명령이라
   REST API로는 실행할 수 없습니다. "② keystore 명령어 보기" 버튼을 누르면 복사해서 각 노드에서
   직접 실행할 명령어를 보여주고, 실행 후 다음 버튼을 눌러 진행하는 방식입니다.
   - SSH로 노드에 직접 접속해서 이 단계까지 자동화하고 싶다면 `ssh2` 또는 `node-ssh` 패키지를 추가해서
     `server/routes/ccr.js`의 `generate-api-key` 응답 이후에 SSH 실행 단계를 넣어주시면 됩니다.
   - 필요하시면 이 부분도 이어서 구현해드릴 수 있습니다.
2. **자격증명은 AES-256-GCM으로 암호화되어 `data/db.json`에 저장**됩니다. 프론트엔드로는 절대 내려가지 않습니다.
   다만 이건 샘플 프로젝트용 최소 보안이며, 운영에 쓰실 거라면 Vault/KMS 연동을 권장합니다.
3. **TLS 인증서 검증을 기본적으로 건너뛸 수 있게** 체크박스를 뒀습니다 (self-signed 인증서 환경 고려).
   실제 운영 환경에서는 CA 인증서를 등록해서 검증을 켜는 걸 권장합니다.
4. **모든 액션은 `data/db.json`의 `actionLog`에 기록**되고, 화면 하단 "실행 로그"에서 확인할 수 있습니다.
5. 방화벽은 이미 열려있다고 가정합니다(1:1 노드 매핑 대신 전체 노드 ↔ 진입점 방식 권장은 이전 대화 참고).

## API 목록

- `POST /api/clusters` — 클러스터 등록
- `GET /api/clusters` — 목록 조회 (자격증명 마스킹됨)
- `DELETE /api/clusters/:id` — 삭제
- `POST /api/clusters/:id/test` — 헬스체크 + 라이선스 확인
- `POST /api/ccr/generate-api-key` — Cross-Cluster API Key 발급
- `POST /api/ccr/register-remote` — remote cluster 등록 (proxy 모드)
- `POST /api/ccr/follow` — follower index 생성
- `GET /api/ccr/stats/:clusterId/:indexName` — 복제 상태 조회
- `POST /api/ccr/remove-remote` — remote cluster 설정 제거
- `POST /api/index-mgmt/sample-index` — 샘플 벡터 인덱스 생성 (+ 시드 문서)
- `GET /api/index-mgmt/:clusterId/:indexName/count` — 문서 수 조회
- `POST /api/dr/failover` — pause_follow → close → unfollow → open
- `POST /api/dr/prepare-failback` — 기존 인덱스 삭제 (역방향 수신 준비)
- `GET /api/logs` — 실행 로그 조회
