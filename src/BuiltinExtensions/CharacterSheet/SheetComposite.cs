using ImageMagick;
using ImageMagick.Drawing;
using SwarmUI.Utils;

using Image = SwarmUI.Utils.Image;

namespace SwarmUI.Builtin_CharacterSheetExtension;

/// <summary>Lays generated panels out into one sheet image.
/// <para>Compositing happens here in C# with ImageMagick rather than in a ComfyUI graph. The grid generator
/// composites the same way, and doing it locally means a failed panel does not cost the whole sheet.</para></summary>
public static class SheetComposite
{
    /// <summary>Gets the label font at a given size multiplier. Matches the Grid Generator so both features draw labels the same way.</summary>
    public static IDrawables<ushort> GetFont(float sizeMult)
    {
        return new Drawables().Font("src/wwwroot/fonts/unifont-12.0.01.woff2", FontStyleType.Normal, FontWeight.Bold, FontStretch.Normal).FontPointSize(16 * sizeMult);
    }

    /// <summary>One panel's placement in the layout grid, in cell units.</summary>
    public record struct Cell(int Col, int Row, int ColSpan, int RowSpan);

    /// <summary>A resolved layout: the grid size, and where each panel sits in it.</summary>
    public record class Layout(int Cols, int Rows, Cell[] Cells, bool PadTo16x9);

    /// <summary>Resolves a layout name and panel count into a concrete grid.
    /// <para>Layouts that only make sense at a specific panel count fall back to a plain grid rather than
    /// erroring, so changing the view selection never invalidates the layout choice.</para></summary>
    public static Layout Resolve(string layoutName, int count)
    {
        if (count < 1)
        {
            return new(1, 1, [], false);
        }
        if (layoutName == "tall_left" && count == 3)
        {
            return new(2, 2, [new(0, 0, 1, 2), new(1, 0, 1, 1), new(1, 1, 1, 1)], false);
        }
        if (layoutName == "wide_top" && count == 3)
        {
            return new(2, 2, [new(0, 0, 2, 1), new(0, 1, 1, 1), new(1, 1, 1, 1)], false);
        }
        if (layoutName == "row")
        {
            return new(count, 1, [.. Enumerable.Range(0, count).Select(i => new Cell(i, 0, 1, 1))], false);
        }
        if (layoutName == "grid2x2" && count <= 4)
        {
            return new(2, 2, [.. Enumerable.Range(0, count).Select(i => new Cell(i % 2, i / 2, 1, 1))], false);
        }
        // sheet16x9 and every fallback: a squarish auto grid, then the canvas is padded out to 16:9 for the
        // sheet layout so the result drops straight into a widescreen slide or reference board.
        int cols = (int)Math.Ceiling(Math.Sqrt(count));
        if (count <= 4)
        {
            cols = count <= 3 ? count : 2;
        }
        int rows = (int)Math.Ceiling(count / (double)cols);
        return new(cols, rows, [.. Enumerable.Range(0, count).Select(i => new Cell(i % cols, i / cols, 1, 1))], layoutName == "sheet16x9");
    }

    /// <summary>Composites panels into one sheet image.</summary>
    /// <param name="panels">The generated panel images, in layout order. Nulls are skipped.</param>
    /// <param name="labels">Caption per panel, same length as <paramref name="panels"/>, or null for no labels.</param>
    /// <param name="layoutName">Layout identifier: row, grid2x2, tall_left, wide_top, or sheet16x9.</param>
    public static Image Build(List<Image> panels, List<string> labels, string layoutName)
    {
        List<Image> live = [.. panels.Where(p => p is not null)];
        if (live.Count == 0)
        {
            return null;
        }
        List<string> liveLabels = [];
        if (labels is not null)
        {
            for (int i = 0; i < panels.Count; i++)
            {
                if (panels[i] is not null)
                {
                    liveLabels.Add(i < labels.Count ? labels[i] : "");
                }
            }
        }
        Layout layout = Resolve(layoutName, live.Count);
        int cellWidth = live.Max(p => (int)p.ToMagick.Width);
        int cellHeight = live.Max(p => (int)p.ToMagick.Height);
        float sizeMult = cellWidth > 800 || cellHeight > 800 ? 2 : 1;
        IDrawables<ushort> font = GetFont(sizeMult);
        int labelHeight = 0;
        if (labels is not null)
        {
            ITypeMetric measured = font.FontTypeMetrics("ABCdefg");
            labelHeight = (int)Math.Ceiling(measured.TextHeight * 1.6);
        }
        int totalWidth = cellWidth * layout.Cols;
        int totalHeight = (cellHeight + labelHeight) * layout.Rows;
        int offsetX = 0, offsetY = 0;
        if (layout.PadTo16x9)
        {
            int wanted = (int)Math.Round(totalHeight * 16.0 / 9.0);
            if (wanted > totalWidth)
            {
                offsetX = (wanted - totalWidth) / 2;
                totalWidth = wanted;
            }
            else
            {
                int wantedHeight = (int)Math.Round(totalWidth * 9.0 / 16.0);
                if (wantedHeight > totalHeight)
                {
                    offsetY = (wantedHeight - totalHeight) / 2;
                    totalHeight = wantedHeight;
                }
            }
        }
        Logs.Info($"[Character Sheet] Compositing {live.Count} panels into a {totalWidth}x{totalHeight} sheet.");
        using MagickImage sheet = new(MagickColors.White, (uint)totalWidth, (uint)totalHeight) { Depth = 8 };
        for (int i = 0; i < live.Count && i < layout.Cells.Length; i++)
        {
            Cell cell = layout.Cells[i];
            int boxX = offsetX + cell.Col * cellWidth;
            int boxY = offsetY + cell.Row * (cellHeight + labelHeight);
            int boxW = cell.ColSpan * cellWidth;
            int boxH = cell.RowSpan * (cellHeight + labelHeight) - labelHeight;
            IMagickImage<ushort> source = live[i].ToMagick;
            // Fit rather than fill: a stretched turnaround panel is worse than a letterboxed one, because the
            // whole point of the sheet is that proportions match across views.
            double scale = Math.Min(boxW / (double)source.Width, boxH / (double)source.Height);
            int drawW = Math.Max(1, (int)Math.Round(source.Width * scale));
            int drawH = Math.Max(1, (int)Math.Round(source.Height * scale));
            using IMagickImage<ushort> scaled = source.Clone();
            scaled.Resize(new MagickGeometry((uint)drawW, (uint)drawH) { IgnoreAspectRatio = true });
            scaled.ResetPage();
            sheet.Composite(scaled, boxX + (boxW - drawW) / 2, boxY + (boxH - drawH) / 2, CompositeOperator.Over);
            if (labelHeight > 0 && i < liveLabels.Count && !string.IsNullOrWhiteSpace(liveLabels[i]))
            {
                DrawCenteredLabel(sheet, sizeMult, liveLabels[i], boxX, boxY + boxH + labelHeight * 0.15, boxW);
            }
        }
        return new Image(sheet);
    }

    /// <summary>Draws one centered, width-wrapped caption under a panel. The cached panel image is not modified.</summary>
    private static void DrawCenteredLabel(MagickImage sheet, float sizeMult, string text, int boxX, double top, int boxW)
    {
        IDrawables<ushort> measure = GetFont(sizeMult);
        List<string> lines = [];
        string line = "";
        foreach (Rune character in text.Replace("\r", "").EnumerateRunes())
        {
            if (character.Value == '\n')
            {
                lines.Add(line);
                line = "";
                continue;
            }
            string candidate = line + character.ToString();
            if (line.Length > 0 && measure.FontTypeMetrics(candidate).TextWidth > boxW)
            {
                lines.Add(line);
                line = character.ToString();
            }
            else
            {
                line = candidate;
            }
        }
        if (line.Length > 0 || lines.Count == 0)
        {
            lines.Add(line);
        }
        ITypeMetric sample = measure.FontTypeMetrics("Ag");
        double baseline = top + sample.Ascent;
        IDrawables<ushort> draw = GetFont(sizeMult).FillColor(MagickColors.Black);
        foreach (string row in lines)
        {
            if (row.Length > 0)
            {
                ITypeMetric rowMetric = measure.FontTypeMetrics(row);
                draw.Text(boxX + (boxW - rowMetric.TextWidth) / 2.0, baseline, row);
            }
            baseline += sample.TextHeight;
        }
        draw.Draw(sheet);
    }
}
