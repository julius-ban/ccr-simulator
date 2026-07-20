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

## 프로토콜(HTTP/HTTPS)

클러스터 등록 시 REST 포트 접속 프로토콜을 HTTP/HTTPS 중에서 고를 수 있습니다 (기본값 HTTPS).
HTTP를 선택하면 TLS 인증서 관련 옵션은 의미가 없어서 자동으로 숨겨집니다. Proxy 포트(CCR 원격
클러스터 연결용)는 ES 자체 사양상 항상 TLS 기반이라 별도 프로토콜 선택 없이 host:port만 사용합니다.

## 교육/시뮬레이션 기능 (신규)

이 프로젝트는 실제 운영 자동화 도구이기도 하지만, **처음 CCR을 배우는 사람이 위험 부담 없이
전체 흐름을 체험**할 수 있도록 아래 기능들을 추가했습니다.

### 🧪 시뮬레이션 모드
헤더의 토글을 켜면 CCR 연동/모니터링/Failover/Failback 관련 API 호출이 **전부 가짜(mock) 응답**으로
처리됩니다. 실제 클러스터에 어떤 영향도 주지 않으면서 전체 절차를 눌러볼 수 있습니다.
- 클러스터 등록/조회처럼 위험하지 않은 API는 시뮬레이션 모드에서도 실제 백엔드를 그대로 호출합니다
  (불필요하게 다 막지 않음 — `public/app.js`의 `shouldSimulate()` 참고).
- follow를 누르면 로컬에서 CCR 링크 상태를 직접 갱신해서(백엔드 SSE 없이) 아키텍처 다이어그램이
  실시간으로 리더/팔로워 배지, 화살표를 바꿔가며 반응합니다.
- 모니터링 lag 게이지는 "리더가 앞서가고 팔로워가 서서히 따라잡는" 모양을 흉내 낸 가짜 숫자로
  움직여서, 실제 클러스터 없이도 lag 개념을 체감할 수 있습니다.
- 검증(6번 섹션, 쿼리 비교)만은 시뮬레이션 모드에서 지원하지 않습니다 — 실제 데이터 비교가 핵심이라
  가짜로 만드는 의미가 없어서, 안내 메시지만 보여주고 실전 모드 전환을 유도합니다.

### 📊 복제 지연(lag) 게이지
"4. CCR 복제 모니터링"에 `leader_global_checkpoint`와 `follower_global_checkpoint`의 차이를
막대바 + 숫자로 실시간 표시합니다. 리더에 대량 삽입하면 lag이 벌어졌다가 다시 좁혀지는 걸
눈으로 볼 수 있습니다.

### 🧭 가이드 모드
헤더 토글을 켜면 지금 눌러야 할 다음 버튼에 주황색 pulsing 테두리가 생기고, 아직 순서가 안 된
이후 버튼들은 흐리게 표시됩니다. 클러스터 등록 → 샘플 인덱스 생성 → CCR 연동 4단계 → 모니터링 →
Failover → Failback 6단계까지, 총 13개 스텝을 순서대로 추적합니다 (`GUIDE_STEPS` 배열,
`markGuideStep()` 호출로 각 버튼 클릭 시 다음 단계로 넘어감).

### 📖 용어집
헤더의 "용어집" 버튼을 누르면 CCR, Leader/Follower, Remote Cluster Server, Checkpoint,
복제 지연(Lag), Failover/Failback, Soft Delete, HNSW, kNN 등 12개 핵심 용어 설명이 모달로 뜹니다.

### 6. 검증 (인덱스 상태 / 쿼리 결과 비교)
- **인덱스 상태 확인**: A/B 두 클러스터+인덱스의 헬스, 문서 수, 매핑을 나란히 조회
- **쿼리 결과 비교**: A(보통 리더)에서 실제 문서 1건을 가져와 그 벡터로 A/B 양쪽에 동일한 kNN
  쿼리를 실행하고, 상위 K개 문서 ID/점수가 정확히 일치하는지 비교합니다. 일치하면 CCR 복제가
  정확하다는 걸 눈으로 증명하는 셈입니다. 목업 서버로 실제 비교 로직까지 검증했습니다.

## Remote Cluster 등록 단계 사전 진단 (신규)

"③ Remote Cluster 등록" (또는 Failback의 "④ 역방향 Remote 등록") 버튼을 누르면 이제 등록만
하고 끝내지 않고, 그 자리에서 바로 진단까지 합니다:

1. **포트 자체 응답 확인** — ES REST 호출과 무관하게, 리더의 remote cluster server 포트(보통
   9443)에 원시 TLS 소켓으로 먼저 접속해봅니다. remote cluster server는 항상 TLS를 쓰기 때문에,
   TLS 핸드셰이크가 성공하는지만 봐도 "이 포트가 열려있고 뭔가 응답한다"는 강한 신호가 됩니다.
2. **ES 레벨 연결 재시도 확인** — `_remote/info`를 한 번만 보지 않고 최대 5회, 1.5초 간격으로
   재시도하며 실제로 `connected: true`가 되는지 확인합니다 (등록 직후엔 아직 연결 중일 수 있어서
   한 번만 보면 오탐이 잦습니다).
3. **원인별 진단 메시지** — 위 두 결과를 조합해서 색깔 있는 안내 박스로 바로 보여줍니다:
   - 🟢 정상 연결됨
   - 🟡 포트는 열려있는데 ES 레벨에서만 안 됨 → keystore 등록/인증서/server_name 쪽 문제 가능성
   - 🔴 포트 자체가 응답 안 함 → 리더의 `remote_cluster_server.enabled`, 포트 설정, 방화벽,
     노드 재시작 여부 확인 필요

버튼을 누르는 동안은 "확인 중... (최대 10초)"로 바뀌고, 끝나면 진단 결과가 버튼 바로 아래에
표시됩니다. follow 단계까지 가서 30초 타임아웃을 기다릴 필요 없이 이 시점에 바로 원인을 알 수 있습니다.

## follow 타임아웃 진단

`_ccr/follow`는 REST(9200)로 나가지만, 내부적으로 팔로워 노드가 리더의 **remote cluster server
포트(보통 9443)**에 실제로 붙어야 완료됩니다. REST(9200) 연결이 되더라도 9443이 막혀있거나 리더에
`remote_cluster_server.enabled`가 꺼져있으면 이 API가 응답을 못 받고 멈춥니다. 그래서:

- follow 실행 전 `GET _remote/info`를 먼저 조회해서 `connected: false`면 30초를 기다리지 않고
  즉시 원인(리더의 remote_cluster.port 설정, 방화벽 9443, keystore 등록 여부)을 안내합니다.
- 그래도 시간이 걸리는 정상 케이스를 위해 전체 타임아웃은 15초 → 30초로 늘렸습니다.

## keystore 명령어 자동완성

"② keystore 명령어 보기"에서 팔로워 클러스터가 선택되어 있으면, `<FOLLOWER_HOST>` 같은 플레이스홀더
대신 실제 등록된 host/포트/계정 정보를 채운 완성된 명령어를 보여줍니다 (팔로워가 API Key 인증이면
`Authorization: ApiKey ...` 헤더 형태로 자동 전환됩니다). 팔로워를 선택하지 않았을 때만 플레이스홀더로
폴백합니다.

## 실제 API 동작 설명 (항상 노출)

CCR 연동/샘플 인덱스/모니터링/Failover/Failback 각 버튼 그룹 아래에 실제로 나가는 REST API(메서드
+ 경로)와 목적을 항상 펼쳐진 상태로 보여주는 안내 박스가 있습니다. 클릭해서 열 필요 없이 바로
읽을 수 있습니다 (문구를 바꾸고 싶으면 `public/index.html`의 `.action-note` 블록을 수정하면 됩니다).

## 이번 수정 사항

1. **아키텍처 상태의 역할 배지** — CCR 링크가 아직 없어도 등록 시 지정한 역할(주센터/DR센터)이
   "(대기 중)"으로 표시됩니다. CCR follow가 성공하면 그때부터 실제 리더/팔로워로 전환됩니다.
2. **실행 로그 UX** — 새 로그가 쌓일 때 스크롤이 자동으로 맨 위로 이동합니다. "로그 복사" 버튼으로
   현재 로그 전체를 클립보드에 복사할 수 있습니다.
3. **벌크 삽입 버그 수정 (중요)** — `_bulk` 요청 시 이미 완성된 NDJSON 문자열을 axios가 Content-Type:
   application/json을 보고 다시 `JSON.stringify()` 해버려서 개행이 깨지고 `"must be terminated by a
   newline"` 400 에러가 나던 문제를 수정했습니다. 문자열 바디는 `Content-Type: application/x-ndjson`
   + `transformRequest` 우회로 원본 그대로 전송되도록 고쳤습니다 (`server/esClient.js`). 로컬 목업
   서버로 실제 바이트 단위까지 확인했습니다.
4. **섹션 순서 재배치 및 설명 보강** — "샘플 벡터 인덱스 생성"이 "CCR 연동"보다 먼저 오도록 순서를
   바꿨습니다 (index를 먼저 만들어야 follow가 그 인덱스를 참조할 수 있기 때문). CCR의 follower는
   자체적으로 인덱스를 찾는 게 아니라 **Leader 클러스터 + Leader 인덱스 이름을 그대로 지정받아서**
   그 인덱스를 원본으로 복제합니다 — 이 관계를 두 섹션에 명시적으로 설명해뒀습니다. 또한 "샘플 인덱스
   생성"과 "CCR 연동"의 클러스터 선택을 서로 자동 동기화(아직 선택 안 한 쪽만)하도록 편의 기능을
   추가했습니다.

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
