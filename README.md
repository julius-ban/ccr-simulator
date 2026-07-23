# ES CCR Failover/Failback 가이드 웹 UI

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

## 화면 구성 (3단 레이아웃)

| 위치 | 내용 |
|---|---|
| 좌측 (고정, 넓음) | 실행 로그, 실시간 이벤트 — 어떤 버튼을 누르든 실제 API 호출/결과가 여기 쌓입니다 |
| 중앙 | 1~6번 순서대로: 클러스터 등록 → 샘플 인덱스 생성 → CCR 연동 → 모니터링 → Failover/Failback → 검증 |
| 우측 (고정) | 아키텍처 상태 다이어그램 — 리더/팔로워 역할, 연결 상태, CCR 방향이 실시간 반영 |

| 화면 섹션 | 절차서 단계 |
|---|---|
| 1. 클러스터 등록 | 사전 확인(0단계) — 주센터/DR센터 접속 정보 등록 |
| 2. 샘플 벡터 인덱스 생성 (rag-vectors) | 4단계 초반 — rag-vectors 매핑/설정 반영, 배치 단위 시드 삽입 |
| 3. CCR 연동 | 3, 4단계 — 인증 방식/연결 모드 선택 → (API Key 발급 →) keystore 등록(수동) → remote 등록 → follower 생성, Auto-follow 패턴 구성 포함 |
| 4. CCR 복제 모니터링 | 4단계 — `_ccr/stats` 폴링 + lag 게이지 |
| 5. Failover / Failback | 5~8단계 — pause_follow→close→unfollow→open, 역방향 CCR 재구성 |
| 6. 검증 | 인덱스 상태 확인 + 리더/팔로워 kNN 쿼리 결과 비교 |

## 아키텍처 상태 패널 (우측 고정)

- **아키텍처 상태**: 주센터/DR센터 박스가 위아래로 표시되고, 각 박스에 연결 상태 점(초록=정상,
  빨강=실패, 회색=미확인), 현재 역할 배지(리더/팔로워/독립 인덱스/역할 미지정), Kibana 바로가기
  링크(등록했다면)가 실시간으로 반영됩니다. 두 박스 사이 화살표는 CCR 연동 방향과 상태를 그대로
  보여줍니다: 초록 실선 = 정상 복제 중, 빨간 점선 = Failover로 끊긴 상태. 실제로 어떤 액션 버튼을
  누르든(연결테스트, CCR 단계, failover/failback 등) 백엔드 → 클러스터 요청이 발생하는 순간 화살표가
  주황색으로 잠깐 반짝입니다.

이 패널의 데이터는 `GET /api/state` (클러스터 목록 + 현재 CCR 링크 상태)로 최초 로드되고, 이후로는
SSE(`/api/events/stream`)의 `state` 이벤트로 실시간 갱신됩니다. CCR 링크 상태는 `data/db.json`의
`ccrLinks` 배열에 저장되며 `server/ccrState.js`가 관리합니다 (follow 성공 시 `linked`, failover의
unfollow 성공 시 `unfollowed`로 전환).

## 실행 로그 / 실시간 이벤트 (좌측 고정)

기존에는 우측 패널에 있었지만, 가장 자주 들여다보는 정보라 **좌측에 더 넓게(420px)** 고정했습니다.
"실행 로그"는 새 항목이 위에 쌓이면서 자동으로 스크롤이 맨 위로 이동하고, "로그 복사" 버튼으로
클립보드에 복사할 수 있습니다. "새로고침" 버튼은 누르는 순간 패널을 완전히 비운 뒤 서버 로그를
다시 채웁니다 (이전 내용이 잔존하지 않음). "실시간 이벤트"는 SSE로 들어오는 개별 요청(성공/실패/
소요시간)을 피드 형태로 보여줍니다.

## 초기화 버튼

헤더의 "🔄 초기화" 버튼을 누르면 확인창을 거쳐 등록된 클러스터, CCR 링크 상태, 실행 로그를 전부
지우고 페이지를 새로고침합니다 (`POST /api/reset`). 프리셋(아래 참고)은 초기화 대상이 아니라
그대로 남습니다 — 다음에 클러스터를 다시 등록하고 이름만 맞추면 프리셋으로 바로 복원할 수 있습니다.
되돌릴 수 없는 작업입니다.

## 🩺 사전 점검 (닥터) — 신규

"3. CCR 연동"의 클러스터/인덱스/인증방식을 선택한 뒤 "🩺 사전 점검" 버튼을 누르면, 실제로 CCR을
시도하기 전에 REST로 확인 가능한 항목들을 한 번에 점검합니다 (`POST /api/ccr/precheck`):

1. **리더/팔로워 라이선스** — Basic이면 CCR 자체가 불가능
2. **버전 호환성** — 팔로워가 리더와 같거나 더 높은 버전이어야 함
3. **리더 인덱스 soft_deletes.enabled** — 꺼져 있으면 그 인덱스는 CCR 대상이 될 수 없음 (생성 시에만
   정해지는 설정이라 변경 불가, 재생성 필요)
4. **팔로워의 remote_cluster_client 역할** — 어떤 노드도 이 역할이 없으면 원격 연결 자체가 불가능
5. **(API Key 인증인 경우만) 리더의 remote_cluster_server.enabled** — 꺼져 있으면 API Key 방식이
   동작하지 않음
6. **기존 remote 설정에 leftover credential이 남아있는지** — 이번에 실제로 겪으신 "API Key credential이
   남은 채로 TLS 인증서 인증으로 전환" 충돌을 여기서 미리 잡아냅니다

각 항목은 ✅ 통과 / ⚠️ 주의 / ❌ 문제로 색깔 있는 표에 표시됩니다. 목업 서버로 정상/실패 케이스
둘 다 테스트했고, 특히 6번 leftover credential 충돌 감지가 정확히 동작하는 것까지 확인했습니다.

## 📤 설정 내보내기 — 실제 요청 이력 기반으로 개선

헤더의 "📤 설정 내보내기" 버튼을 누르면, **이번 세션에서 실제로 클러스터에 전송된 요청**을 실행
순서 그대로 캡처해서 Markdown 파일로 다운로드합니다. 처음엔 폼 값을 바탕으로 요청을 추측해서
재구성하는 방식이었는데, 백엔드가 이미 모든 REST 호출을 SSE로 흘려보내고 있어서 그 요청을
그대로 재사용하도록 바꿨습니다 — **폼 값 재구성이 아니라 진짜 실행 이력**입니다.

- 백엔드: `server/esClient.js`의 `call()`이 SSE `traffic` 이벤트에 요청 메서드/경로뿐 아니라
  **요청 바디까지** 함께 흘려보냅니다 (`base.body = data`). 인증정보는 body가 아니라 header에
  있어서 노출되지 않습니다.
- 프론트: `app.js`가 SSE `traffic`의 `end` 이벤트를 받을 때마다 `apiCallHistory` 배열에
  {시각, 클러스터, 메서드, 경로, 바디, 성공여부}를 계속 쌓아둡니다 (최근 300개까지).
- 내보내기 버튼을 누르면 이 이력 중 **실제로 상태를 바꾼 요청만** 골라냅니다 — 인덱스 생성/삭제,
  Remote Cluster 등록, API Key 발급, follow/auto-follow/unfollow, failover의 pause_follow →
  close → unfollow → open, `_bulk` 삽입 등. 헬스체크·라이선스 확인·모니터링 폴링·사전점검 조회
  같은 읽기 전용 호출은 자동으로 제외됩니다 (`isExportableCall()`).
- 각 단계는 번호가 매겨진 섹션으로, ` ```http ` 블록(메서드+경로)과 ` ```json ` 블록(실제 바디,
  성공/실패 여부 포함)으로 예쁘게 정리됩니다. `_bulk`처럼 바디가 큰 경우 3000자에서 잘라서
  파일이 과도하게 커지지 않게 합니다.
- 세션 중 아무 것도 실행한 게 없으면 "먼저 몇 단계 진행해보라"는 안내만 뜨고 다운로드는 안 됩니다.

이제 CCR 연동뿐 아니라 샘플 인덱스 생성, Failover, Failback, Auto-follow, 다중 인덱스 일괄 Follow
까지 세션에서 실행한 모든 단계가 하나의 문서에 순서대로 남습니다 — 팀 공유나 증적 자료로 쓰기에
훨씬 정확합니다.

## 다중 인덱스 일괄 Follow — 신규

"CCR 연동" 하단에 리더 인덱스 목록(줄바꿈 또는 콤마 구분)과 팔로워 이름 패턴(`{{leader_index}}-follower`
같은 템플릿)을 입력하면, 목록의 각 인덱스에 대해 순서대로 `PUT /{인덱스}/_ccr/follow`를 호출합니다.
진행 중인 인덱스, 완료된 인덱스, 실패한 인덱스를 실시간으로 테이블에 표시합니다. Auto-follow(신규
인덱스 자동 복제)와는 달리 **지금 이미 존재하는 인덱스들**을 한 번에 처리할 때 씁니다.

## 💾 시나리오 프리셋 저장/불러오기 — 신규

헤더의 "💾 프리셋" 버튼으로 모달을 엽니다.
- **저장**: 지금 화면에 선택/입력된 클러스터, 인덱스명, 인증방식, 연결모드, Auto-follow/일괄 Follow
  설정 등을 이름 붙여 저장합니다. **클러스터는 ID가 아니라 이름으로 저장**됩니다 — 초기화 후 클러스터를
  다시 등록해도(ID는 바뀌지만 이름만 같으면) 프리셋을 불러올 때 자동으로 다시 매칭됩니다.
- **불러오기**: 저장된 프리셋을 선택하면 모든 필드가 그대로 채워지고, 인증방식/클러스터 선택에 딸린
  화면 로직(연결모드 강제, 흐림 처리 등)도 `change` 이벤트를 통해 정상적으로 다시 실행됩니다.
- **삭제**: 프리셋 목록에서 개별 삭제 가능
- 백엔드: `GET/POST /api/presets`, `DELETE /api/presets/:id`, `data/db.json`의 `presets` 배열에 저장

## 버튼 호버 툴팁 · 완성된 API 미리보기

- CCR 연동/모니터링/Failover/Failback의 각 버튼에 마우스를 올리면, 그 버튼을 눌렀을 때 실제로
  나가는 REST API(메서드+경로)와 목적이 툴팁으로 뜹니다 (하단에 항상 떠 있던 설명 박스는 없앴습니다).
  버튼의 `data-tooltip` 속성에 내용이 들어있어서, 문구를 바꾸고 싶으면 `public/index.html`에서
  해당 속성만 수정하면 됩니다.
- "5. Failover / Failback 실행" 제목 아래에는 Failover/Failback 용어 설명이 항상 펼쳐진 채로 있습니다.
- "인덱스 생성 + 시드 삽입" 버튼 옆의 **"✅ 완성된 API 보기"** 버튼을 누르면, 지금 입력한 값 그대로
  실제 전송될 요청을 모달로 보여줍니다. "인덱스 생성 API" / "시드 삽입 API" 두 탭으로 나뉘어 있고,
  백엔드의 `POST /api/index-mgmt/preview` 엔드포인트가 실제 실행 로직(`buildDefaultIndexBody`,
  `makeDocument`)과 완전히 같은 코드로 미리보기를 만들기 때문에 실제 실행 결과와 어긋나지 않습니다.

## 프로토콜(HTTP/HTTPS)

클러스터 등록 시 REST 포트 접속 프로토콜을 HTTP/HTTPS 중에서 고를 수 있습니다 (기본값 HTTPS).
HTTP를 선택하면 TLS 인증서 관련 옵션은 의미가 없어서 자동으로 숨겨집니다. Proxy 포트(CCR 원격
클러스터 연결용)는 ES 자체 사양상 항상 TLS 기반이라 별도 프로토콜 선택 없이 host:port만 사용합니다.

## 교육/가이드 기능 (신규)

이 프로젝트는 실제 운영 자동화 도구이기도 하지만, **처음 CCR을 배우는 사람이 전체 흐름을 순서대로
따라갈 수 있도록** 아래 기능들을 추가했습니다.

### 📊 복제 지연(lag) 게이지
"4. CCR 복제 모니터링"에 `leader_global_checkpoint`와 `follower_global_checkpoint`의 차이를
막대바 + 숫자로 실시간 표시합니다. 리더에 대량 삽입하면 lag이 벌어졌다가 다시 좁혀지는 걸
눈으로 볼 수 있습니다.

### 🧭 가이드 모드 (항상 켜짐, 토글 없음)
페이지를 열면 바로 지금 눌러야 할 다음 버튼에 주황색 pulsing 테두리가 생기고, 아직 순서가 안 된
이후 버튼들은 흐리게 표시됩니다. 클러스터 등록 → 샘플 인덱스 생성 → CCR 연동 4단계 → 모니터링 →
Failover → Failback 6단계까지, 총 13개 스텝을 순서대로 추적합니다 (`GUIDE_STEPS` 배열,
`markGuideStep()` 호출로 각 버튼 클릭 시 다음 단계로 넘어감). 껐다 켰다 할 수 있는 옵션이 아니라
이 콘솔의 기본 동작입니다.

### 📖 용어집
헤더의 "용어집" 버튼을 누르면 CCR, Leader/Follower, Remote Cluster Server, Checkpoint,
복제 지연(Lag), Failover/Failback, Soft Delete, HNSW, kNN 등 12개 핵심 용어 설명이 모달로 뜹니다.

### 6. 검증 (인덱스 상태 / 쿼리 결과 비교)
- **인덱스 상태 확인**: A/B 두 클러스터+인덱스의 헬스, 문서 수, 매핑을 나란히 조회
- **쿼리 결과 비교**: A(보통 리더)에서 실제 문서 1건을 가져와 그 벡터로 A/B 양쪽에 동일한 kNN
  쿼리를 실행하고, 상위 K개 문서 ID/점수가 정확히 일치하는지 비교합니다. 일치하면 CCR 복제가
  정확하다는 걸 눈으로 증명하는 셈입니다. 목업 서버로 실제 비교 로직까지 검증했습니다.

## CCR 인증 방식 (API Key / TLS 인증서) & 연결 모드 (Sniff / Proxy) — 신규

"3. CCR 연동"과 Failback 마법사에 두 가지 셀렉트가 추가됐습니다.

### CCR 인증 방식
- **TLS 인증서 기반 인증 (~9.X, 기본값)**: API Key 발급/keystore 단계 버튼이 아예 숨겨지고, 대신
  "양쪽 클러스터 transport 계층(9300)이 같은 CA를 신뢰하도록 인증서를 미리 맞춰둬야 한다"는 안내
  박스가 뜹니다. 이 인증서 배포 자체는 OS 레벨 작업이라 REST로 자동화할 수 없어서, keystore
  명령어 안내와 마찬가지로 "준비되어 있다는 전제"로 바로 Remote 등록 단계로 넘어갑니다.
- **API Key 인증 (8.14 ~)**: ① API Key 발급 → ② keystore 등록 → ③ Remote 등록(Proxy 모드 고정,
  remote cluster server 포트 사용) 순서로 진행합니다.

### 연결 모드
- TLS 인증서 인증을 선택하면 **Sniff(기본)/Proxy**를 자유롭게 고를 수 있습니다.
  - Sniff: 클러스터 등록 시 입력한 host를 기본 seed로 쓰고, "추가 Seed 노드" 입력란에 콤마로
    나머지 노드(`172.21.133.180:9300,172.21.133.181:9300`처럼)를 더 넣을 수 있습니다. 실무에서는
    팔로워의 모든 노드가 리더의 모든 노드에 도달 가능해야 하는 풀 메쉬 구조라는 걸 진단 메시지에서도
    안내합니다.
  - Proxy: transport 포트(클러스터 등록 시 입력한 `Transport 포트`, 기본 9300) 하나로 연결합니다.
- API Key 인증을 선택하면 연결 모드는 **Proxy로 자동 고정**되고 셀렉트가 비활성화됩니다
  (remote cluster server 인터페이스 자체가 proxy 전용이라 Sniff를 지원하지 않습니다).

클러스터 등록 폼에 **Transport 포트**(기본 9300) 필드가 새로 생겼습니다 — Sniff/인증서 기반 연결이
쓰는 포트로, 기존 Proxy 포트(API Key 인증용, 기본 9443)와는 별개입니다.

세 가지 조합(API Key+Proxy / 인증서+Sniff / 인증서+Proxy) 모두 목업 서버로 실제 `_cluster/settings`
페이로드가 올바르게 만들어지는지 확인했습니다.

### 버그 수정: 같은 alias로 모드를 전환할 때 400 에러가 나던 문제
ES의 `cluster.remote.<alias>.*` 설정은 persistent라서, 예를 들어 같은 alias를 Proxy로 등록해둔
상태에서 나중에 Sniff로 바꾸려고 `seeds`만 새로 보내면 "이전에 남아있던 `mode=proxy`"와 충돌해서
`illegal_argument_exception`(400)이 났습니다. 이제 Remote 등록 시 항상 `mode`를 명시적으로 지정하고,
반대 모드에서만 쓰는 필드(`proxy_address`/`server_name` 또는 `seeds`)는 `null`로 명시적으로 지워서
이전에 어떤 모드로 등록되어 있었든 항상 깨끗하게 덮어써지도록 고쳤습니다
(`server/routes/ccr.js`의 `buildRemoteSettings()`). ES처럼 persistent 설정을 병합/검증하는
목업 서버로 proxy→sniff→proxy 전환 전 과정을 재현해서 확인했습니다.

## Auto-follow 패턴 구성 — 신규

지금까지는 이미 존재하는 인덱스 하나를 지정해서 CCR로 복제하는 것만 가능했습니다. "3. CCR 연동"
하단에 **Auto-follow 패턴** 구성을 추가해서, 리더에 패턴에 맞는 인덱스가 **앞으로 새로 생길 때마다**
자동으로 팔로워가 만들어지도록 등록할 수 있습니다 (지금 이미 있는 인덱스는 대상이 아닙니다).

- 패턴 이름, Leader 인덱스 패턴(콤마구분, 예: `rag-vectors-*, other-*`), Follower 인덱스 이름 패턴
  (`{{leader_index}}-follower`처럼 템플릿 문법 지원)을 입력하고 생성/조회/삭제할 수 있습니다.
- 내부적으로 `PUT/GET/DELETE /_ccr/auto_follow/{패턴이름}`을 호출합니다. 패턴을 삭제해도 이미
  자동으로 만들어진 팔로워 인덱스 자체는 그대로 유지됩니다.
- 목업 서버로 생성 → 조회 → 삭제 전체 흐름과, 콤마+공백이 섞인 패턴 문자열이 배열로 정확히
  파싱되는지(`"rag-vectors-*, other-*"` → `["rag-vectors-*", "other-*"]`)까지 확인했습니다.

## Remote Cluster 등록 단계 사전 진단 (신규)

"③ Remote Cluster 등록" (또는 Failback의 "④ 역방향 Remote 등록") 버튼을 누르면 이제 등록만
하고 끝내지 않고, 그 자리에서 바로 진단까지 합니다:

1. **포트 자체 응답 확인** — ES REST 호출과 무관하게, 실제 연결 대상 포트(API Key 인증이면
   remote cluster server 포트/보통 9443, TLS 인증서 인증이면 transport 포트/보통 9300)에 원시 TLS
   소켓으로 먼저 접속해봅니다. TLS 핸드셰이크가 성공하는지만 봐도 "이 포트가 열려있고 뭔가
   응답한다"는 강한 신호가 됩니다.
2. **ES 레벨 연결 재시도 확인** — `_remote/info`를 한 번만 보지 않고 최대 5회, 1.5초 간격으로
   재시도하며 실제로 `connected: true`가 되는지 확인합니다 (등록 직후엔 아직 연결 중일 수 있어서
   한 번만 보면 오탐이 잦습니다).
3. **원인별 진단 메시지** — 위 두 결과와 인증 방식/연결 모드를 조합해서 색깔 있는 안내 박스로
   바로 보여줍니다:
   - 🟢 정상 연결됨
   - 🟡 포트는 열려있는데 ES 레벨에서만 안 됨 → API Key 인증이면 keystore 등록/server_name,
     TLS 인증서 인증이면 CA 신뢰 관계 쪽 문제 가능성
   - 🔴 포트 자체가 응답 안 함 → API Key 인증이면 `remote_cluster_server.enabled`/포트/방화벽/재시작
     여부, TLS 인증서 인증이면 방화벽의 transport 포트(9300) 개방 여부 확인 필요 (Sniff 모드면
     풀 메쉬 연결이 필요하다는 점도 함께 안내됩니다)

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
- `POST /api/ccr/generate-api-key` — Cross-Cluster API Key 발급 (API Key 인증 모드에서만 사용)
- `POST /api/ccr/register-remote` — remote cluster 등록. body에 `authMode`('apikey'|'cert'),
  `connectionMode`('proxy'|'sniff'), `leaderHost`, `leaderProxyPort`, `leaderTransportPort`,
  `extraSeeds`(sniff용 콤마구분 추가 seed)를 받아 조합에 맞는 설정을 생성
- `POST /api/ccr/follow` — follower index 생성
- `GET /api/ccr/stats/:clusterId/:indexName` — 복제 상태 조회
- `POST /api/ccr/remove-remote` — remote cluster 설정 제거
- `POST /api/ccr/auto-follow` — Auto-follow 패턴 생성
- `GET /api/ccr/auto-follow/:clusterId/:patternName` — Auto-follow 패턴 상태 조회
- `DELETE /api/ccr/auto-follow/:clusterId/:patternName` — Auto-follow 패턴 삭제
- `POST /api/index-mgmt/sample-index` — 샘플 벡터 인덱스 생성 (+ 시드 문서)
- `POST /api/index-mgmt/preview` — "완성된 API 보기" 다이얼로그용, 실행 없이 요청 내용만 반환
- `GET /api/index-mgmt/:clusterId/:indexName/count` — 문서 수 조회
- `POST /api/dr/failover` — pause_follow → close → unfollow → open
- `POST /api/dr/prepare-failback` — 기존 인덱스 삭제 (역방향 수신 준비)
- `GET /api/verify/index-check/:clusterId/:indexName` — 인덱스 헬스/문서수/매핑 확인
- `POST /api/verify/compare-query` — 리더/팔로워 kNN 쿼리 결과 비교
- `GET /api/state` — 클러스터 + CCR 링크 상태 스냅샷 (아키텍처 다이어그램 초기 렌더링용)
- `GET /api/events/stream` — SSE (traffic/state 이벤트 실시간 스트림)
- `GET /api/logs` — 실행 로그 조회
- `POST /api/reset` — 전체 초기화 (클러스터/CCR 링크/로그 전부 삭제)
- `POST /api/ccr/precheck` — 사전 점검(닥터): 라이선스/버전/soft_deletes/역할/leftover credential 등 일괄 확인
- `GET /api/presets` — 저장된 시나리오 프리셋 목록
- `POST /api/presets` — 프리셋 저장
- `DELETE /api/presets/:id` — 프리셋 삭제
