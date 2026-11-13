# @rollprobe/report

Offline HTML report generator for Rollprobe campaigns.

## Features

- Self-contained HTML reports (no backend required)
- Interactive event timeline with filtering
- Coverage matrix visualization
- Evidence viewer with expandable details
- Responsive design for mobile/desktop
- Client-side interactivity via embedded JavaScript

## Usage

```typescript
import { ReportGenerator } from '@rollprobe/report';

const generator = new ReportGenerator({
  includeTimeline: true,
  includeCoverageMatrix: true,
  includeEvidenceViewer: true
});

const report = generator.generate(events, observations, checks, coverage);

// Write to file
await fs.writeFile('report.html', report);
```

## Output Structure

The generated HTML includes:

1. **Summary Cards**: Total events, checks, violations, pass rate
2. **Event Timeline**: Chronological view of all campaign events
3. **Coverage Matrix**: Campaign × status breakdown
4. **Evidence Viewer**: Expandable observations and check results
5. **Interactive Elements**: Click-to-expand evidence items

## Example

```bash
npm run report -- --input .rollprobe/logs --output report.html
```

This will generate an interactive HTML report at `report.html` that can be opened in any browser without network access.
