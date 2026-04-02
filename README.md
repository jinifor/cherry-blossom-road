# 🌸 Cherry Blossom Road

## 1. Overview

Cherry Blossom Road는 [서울시 가로수 위치정보](https://data.seoul.go.kr/dataList/OA-1325/S/1/datasetView.do)를 기반으로,
서울의 벚나무 분포를 지도에서 탐색하고 거리 조건에 따라 벚꽃길 후보 군집을 분석하는 프론트엔드 전용 웹 애플리케이션입니다.

현재 프로젝트는 `public/seoul_cb_tree.csv`에 포함된 13,918건의 벚나무 데이터를 브라우저에서 직접 읽어 분석하며,
분석 결과를 MapLibre 지도 위에 포인트, 군집 영역, 추천 벚꽃길 형태로 시각화합니다.

---

## 2. Current Features

### 2.1 Data Loading

- 앱 시작 시 `public/seoul_cb_tree.csv`를 자동으로 로드
- UTF-8 / EUC-KR 디코딩 대응
- `X/Y` 또는 `LNG/LAT` 좌표 컬럼 처리
- `GU_NM`, `WDPT_NM`, `THT_HG`, `BHT_DM`, `WTRTB_BT`, `PLT_DE` 등의 메타데이터 파싱

### 2.2 Map Visualization

- 서울 벚나무 위치를 지도 위 포인트로 표시
- 확대, 축소, 이동 가능한 인터랙티브 지도
- 분석 결과 범위 자동 맞춤
- 포인트, 군집, 추천 영역 클릭 시 팝업 표시
- 지도 위 벚꽃잎 파티클 효과 렌더링

### 2.3 Spatial Analysis

- 사용자가 설정한 거리 기준으로 인접한 나무를 하나의 군집으로 그룹화
- Union-Find 기반 연결 컴포넌트 계산
- 최소 나무 수 조건을 만족하는 군집만 결과에 반영
- 군집별 면적, 범위(span), 대표 자치구, 대표 수종 계산

### 2.4 Geometry Generation

군집 영역을 아래 방식 중 하나로 생성할 수 있습니다.

- `buffer`: 여유 있게 감싼 영역
- `convex`: 바깥 외곽선 기준 영역
- `concave`: 형태를 더 자연스럽게 따르는 영역

### 2.5 Recommendation

- 군집 점수를 계산해 상위 5개 벚꽃길 후보 추천
- 추천 목록에서 항목 클릭 시 해당 군집으로 지도 이동
- 추천 점수, 면적, 나무 수, 범위를 함께 표시

### 2.6 UI / UX

- 거리 기준 슬라이더 (`5m ~ 30m`)
- 최소 나무 수 입력
- 자치구 필터
- 영역 생성 방식 선택
- 지도 표시 모드 선택 (`전체`, `위치`, `영역`)
- 분석 요약 카드 제공
- 모바일 슬라이드 패널 지원
- 현재 위치 이동 버튼 제공

---

## 3. Data

### 3.1 Bundled Dataset

- 파일 위치: `public/seoul_cb_tree.csv`
- 현재 앱은 업로드 UI 없이 위 파일을 자동 로드하는 방식으로 동작

### 3.2 Supported Columns

#### Required

- `WDPT_NM` 또는 `WDPT`: 수목명
- `LNG` 또는 `X`: 경도
- `LAT` 또는 `Y`: 위도

#### Optional

- `GU_NM` 또는 `GU`: 자치구
- `THT_HG`: 수고
- `BHT_DM`: 흉고직경
- `WTRTB_BT`: 수관폭
- `PLT_DE` 또는 `CREAT_DE`: 식재일

---

## 4. User Flow

1. 앱이 시작되면 `seoul_cb_tree.csv`를 자동으로 읽습니다.
2. CSV를 파싱해 벚나무 좌표와 메타데이터를 정규화합니다.
3. 거리 기준으로 인접한 나무들을 연결해 군집을 계산합니다.
4. 군집별 영역과 통계 정보를 생성합니다.
5. 조건을 만족하는 군집 중 상위 추천 구간을 선정합니다.
6. 지도와 왼쪽 패널에 분석 결과를 렌더링합니다.

---

## 5. Architecture

### 5.1 Frontend Only

- 데이터: 정적 CSV 파일
- 분석: 브라우저 내 TypeScript 로직
- 시각화: MapLibre GL JS
- 상태 관리: React state

### 5.2 Data Flow

```text
CSV -> decode/parse -> normalize -> clustering -> geometry generation -> scoring -> map rendering
```

---

## 6. Tech Stack

### Core

- React 19
- TypeScript
- Vite

### Visualization

- MapLibre GL JS
- OpenFreeMap style tiles

### Data Handling

- Papa Parse

### Spatial Analysis

- Turf.js

---

## 7. Key Algorithms

### 7.1 Connected Components

- 거리 임계값 이하의 포인트를 같은 군집으로 연결
- 격자 버킷으로 근접 후보를 줄인 뒤 Union-Find로 병합

### 7.2 Geometry Generation

- 1개 포인트: 원형 버퍼
- 2개 포인트: 선 버퍼
- 3개 이상: `buffer`, `convex`, `concave` 중 선택
- 실패 시 envelope 기반 fallback geometry 사용

### 7.3 Recommendation Score

- 기본 추천 점수는 아래 공식을 사용

```text
score = treeCount * log10(density + 10)
```

- 나무 수가 많고 좁은 영역에 밀집할수록 점수가 높아집니다.

---

## 8. Current Limitations

- 현재 데이터 파일은 고정 경로 자동 로드 방식이며, CSV 업로드 UI는 없습니다.
- 거리 기준은 직선 거리 기반이며 실제 도로 네트워크를 따르지 않습니다.
- 추천 점수 방식과 추천 개수는 코드에 기본값이 있으나 UI에서 직접 변경할 수 없습니다.
- 지도 표시 모드는 `전체`, `위치`, `영역`만 UI에서 제공됩니다.

---

## 9. Future Enhancements

- CSV 업로드 및 데이터 파일 교체 UI
- 추천 점수 방식 선택 UI
- 추천 구간만 별도로 보는 전용 뷰 모드 노출
- 도로 네트워크 기반 벚꽃길 분석
- 사용자 위치 기반 근처 벚꽃길 추천
- 개화 시기나 계절 데이터 결합

---

## 10. Definition of Done

- 정적 CSV를 자동으로 로드할 수 있다.
- 지도에 벚나무 위치를 표시할 수 있다.
- 거리 기반 군집 분석이 동작한다.
- 거리, 최소 개수, 자치구, 영역 생성 방식을 변경할 수 있다.
- 군집 영역과 추천 벚꽃길을 시각화할 수 있다.
- 추천 목록에서 지도 이동과 상세 확인이 가능하다.

---

## 11. Start

```bash
# 의존성 설치
npm install

# 개발 서버 실행
npm run dev

# 타입 체크
npm run typecheck

# 프로덕션 빌드
npm run build
```

---

## 12. Summary

현재 Cherry Blossom Road는 서울 벚나무 데이터를 브라우저에서 직접 분석해,
벚꽃이 밀집된 군집과 추천 벚꽃길 후보를 지도 위에서 탐색할 수 있게 해주는 애플리케이션입니다.

문서 내용은 현재 코드 기준으로 정리되어 있으며,
향후 계획과 현재 구현 범위를 분리해 반영했습니다.
