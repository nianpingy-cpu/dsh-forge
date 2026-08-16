# Example: vision

Inspect a UI screenshot, analyze a client data file, and generate a chart.

## Scenario

Review a screenshot for obvious visual problems, understand a small data file,
and produce a chart for a client.

## Required binaries

- None — the plugin's deterministic worker runs on the current Node
  executable.

## Steps

```text
1. vision_inspect(input: "screenshot.png")
                                            # read: format, dimensions, contrast
2. data_analyze(data: "client-sales.csv")
                                            # read: rows, columns, statistics
3. chart_generate(data: "client-sales.csv", type: "bar",
                  title: "Monthly sales", output: "sales.svg")
                                            # workspace-write
```

## Expected result

The screenshot is described with structural diagnostics (format, dimensions,
contrast), the CSV is summarized with descriptive statistics, and an SVG chart
is written into the workspace. Nothing is overwritten unless `overwrite: true`.

## Permissions

`vision_inspect` and `data_analyze` are `read`. `chart_generate` is
`workspace-write` and requires permission approval.
