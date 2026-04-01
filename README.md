# 🌸 Cherry Blossom Road (README.md)

## 1. Overview

[서울시 가로수 위치정보](https://data.seoul.go.kr/dataList/OA-1325/S/1/datasetView.do) 데이터를 기반으로,
13,918 그루의 벚나무(벚나무/산벚나무/수양벚나무/왕벚나무)를 사용자가 설정한 거리 조건에 따라 밀집되거나 연속적으로 분포한 구간을 분석하고,
이를 지도 위에 시각화하여 벚꽃 나들이에 적합한 지역을 탐색할 수 있는 웹 애플리케이션을 개발한다.

---

## 2. Goals

* 벚나무 위치 데이터를 직관적으로 시각화
* 벚꽃이 "많이 있는 곳"과 "연속적으로 이어진 구간"을 구분하여 제공
* 사용자 설정(거리 등)에 따라 분석 결과를 동적으로 변경
* 서버 없이 클라이언트 단에서 동작하는 경량 웹 앱 구현

---

## 3. Data

### Input

* CSV 파일
* 필수 컬럼:

  * `WDPT_NM`: 수목명
  * `LNG`: 경도
  * `LAT`: 위도

### Optional
  * `GU_NM`: 구 명
  * `THT_HG`: 수고 (나무 높이)
  * `BHT_DM`: 흉고지름 (지면에서 약 1.2m 높이에서 측정한 줄기 직경)
  * `WTRTB_BT`: 수관너비 (나무의 가지/잎이 퍼진 폭 - 캐노피 크기)
  * `PLT_DE`: 식재일

---

## 4. Core Features

### 4.1 Data Visualization

* CSV 데이터를 로드하여 지도에 벚나무 위치를 점(Point)으로 표시
* 확대/축소 및 이동 가능한 인터랙티브 지도 제공

### 4.2 Distance-Based Grouping

* 사용자 입력 거리(예: 10m)를 기준으로 벚나무를 그룹화
* 거리 이하의 포인트들을 연결하여 동일 그룹으로 묶음
* 연결된 컴포넌트(Connected Components) 기반 그룹 생성

### 4.3 Cluster Filtering

* 최소 나무 수 조건 설정 (예: 5그루 이상)
* 조건을 만족하는 그룹만 표시

### 4.4 Spatial Representation

각 그룹을 다음 방식 중 하나로 시각화:

* 버퍼 병합 (buffer + dissolve)
* convex hull
* concave hull (권장)

### 4.5 Highlighted Areas

* 벚나무 밀집 지역 표시
* 벚꽃길 후보 구간 강조

---

## 5. User Controls

* 거리 임계값 (slider)
  * 예: 5m ~ 30m
* 최소 나무 수 필터
* 시각화 모드:
  * 포인트 보기
  * 그룹 영역 보기
  * 강조 구간 보기
* 행정구역 필터 (optional)

---

## 6. Processing Pipeline

1. CSV 데이터 로드
2. 좌표 파싱
3. 거리 기반 인접 관계 계산
4. 포인트 간 연결 그래프 생성
5. 연결된 그룹 도출
6. 그룹별:
   * 개수 계산
   * 영역 생성
7. 필터링 적용
8. 시각화 데이터 생성
9. MapLibre GL JS로 렌더링

---

## 7. Architecture

### Frontend Only Architecture

* 데이터: 정적 CSV 파일
* 분석: 브라우저 내 JavaScript
* 시각화: MapLibre GL JS

### Data Flow

```
CSV → Parsing → Spatial Analysis → Grouping → Geometry 생성 → MapLibre GL JS Rendering
```

---

## 8. Tech Stack

### Core

* MapLibre GL JS (지도 시각화)
* Mapbox or OpenStreetMap (베이스맵)

### Data Handling

* Papa Parse (CSV 파싱)

### Spatial Analysis

* Turf.js

  * distance
  * buffer
  * dissolve
  * convex/concave hull

### Optional Optimization

* kdbush / rbush (공간 인덱싱)
* supercluster (밀집 분석)

### Etc

* 빌드 도구 : vite
* UI 라이브러리 : tailwindcss + shadcn/ui

---

## 9. Key Algorithms

### 9.1 Distance-Based Graph Construction

* 모든 포인트 간 거리 계산 (최적화 필요)
* threshold 이하인 경우 edge 생성

### 9.2 Connected Components

* DFS 또는 Union-Find로 그룹 생성

### 9.3 Geometry Generation

* 그룹별 외곽 영역 생성
* buffer union 또는 hull 사용

---

## 10. Constraints

* 서버 없이 동작해야 함
* 대용량 데이터 처리 시 성능 최적화 필요
* 위경도 기반 거리 계산 정확성 고려 필요

---

## 11. Performance Considerations

* O(n²) 거리 계산 회피
* 공간 인덱스 활용
* Web Worker 도입 가능
* 렌더링 레이어 최소화

---

## 12. Limitations

* 직선 거리 기준 → 도로 단위 분석 아님
* 실제 "길" 분석은 추가 데이터 필요
* 버퍼 방식에 따라 시각적 왜곡 가능

---

## 13. Future Enhancements

* 도로 네트워크 기반 벚꽃길 분석
* 개화 시기 예측 데이터 결합
* 추천 경로 생성
* 사용자 위치 기반 추천
* 모바일 최적화

---

## 14. Definition of Done

* CSV 업로드 또는 로드 가능
* 지도에 벚나무 표시
* 거리 기반 그룹화 동작
* 사용자 옵션에 따라 결과 변경
* 그룹 영역 시각화
* 최소 필터 적용 가능

---

## 15. Start

```
# 의존성 설치
npm install

# 개발 서버 실행
npm run dev

# 프로덕션 빌드
npm run build
```

---

## 16. Summary

본 프로젝트는 벚나무 위치 데이터를 활용하여
단순한 점 지도에서 나아가 **벚꽃 밀집 지역과 연속 구간을 탐색 가능한 지도 서비스**를 구현하는 것을 목표로 한다.

핵심은 **브라우저 내 공간 분석 + maplbire gl js 시각화의 결합**이다.
