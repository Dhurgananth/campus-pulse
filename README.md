# Campus Pulse
WHAT CAMPUS THINKS. WHAT CAMPUS DOES. — live survey dashboard for World Usability Day × Data Science.
Red × black, no scrolling on desktop/tablet, one-page: 10 questions, 10 different chart types.

## Run (Python 3.9+, nothing to install)
    python3 server.py              # dashboard:  http://localhost:8000
    python3 server.py --port 9000  # other port
                                   # volunteer form for phones: http://<your-ip>:8000/form  (printed on start)

## Data (plain CSV, in ./data)
- responses.csv       real responses submitted through the form (appended live)
- demo_responses.csv  150 generated demo responses (shown only while "Demo data" is ON)
- settings.json       remembers whether demo data is on
`python3 server.py --regen-demo` rebuilds the 150 demo rows.

## One chart type per question
| Q | Question | Chart |
|---|----------|-------|
| 1 | State / UT of origin | India choropleth map (+ chips for tiny UTs, top-5 list) |
| 2 | Daily social media hours | Histogram + cumulative curve |
| 3 | Favourite platform | Bubble pack |
| 4 | Sleep | Violin + box plot (shape is *estimated* from the answer ranges) |
| 5 | AI platform | Radar |
| 6 | Physical activity | Nightingale rose |
| 7 | Food habits | Waffle (100 squares) |
| 8 | Entertainment | Lollipop |
| 9 | Transport | Pareto (top 5 + rest, cumulative % line) |
| 10 | Career | Treemap |
| – | Social media × Sleep | Spearman-correlation heatmap |

Click any mark (or the map) to cross-filter every chart. Hover/focus for details.

## Using it
- Add response (or press N): large form, 10 required dropdowns. Type-ahead + Tab to move, Ctrl+Enter to submit.
  "Keep open for next response" lets a volunteer log entries back to back. Undo appears after each submit.
  Double-clicks cannot create duplicates (idempotency key + server check).
- Demo data switch (or D): include/exclude the 150 demo rows. Charts update instantly.
- C or Esc clears filters. F = fullscreen for a projector. Menu (...) = CSV download, volunteer form, reset live data (backup kept).
- Phones (≤640px): one chart at a time with prev/next or swipe.
- No names, phone numbers or emails are collected or stored.

## Credits
India state/UT boundaries: derived from the open `udit-001/india-maps-data` repository (simplified, re-projected).
Check that project's licence before redistributing the map outside this event.
Charts: Chart.js (vendored, MIT); the other chart types are hand-drawn SVG.
