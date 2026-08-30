using FreneticUtilities.FreneticExtensions;
using SixLabors.Fonts;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Drawing.Processing;
using SixLabors.ImageSharp.Processing;
using SwarmUI.Utils;
using System.Collections.Concurrent;

using Image = SwarmUI.Utils.Image;
using ISImage = SixLabors.ImageSharp.Image;
using ISImageRGBA = SixLabors.ImageSharp.Image<SixLabors.ImageSharp.PixelFormats.Rgba32>;

namespace SwarmUI.Builtin_CharacterSheetExtension;

/// <summary>Lays generated panels out into one sheet image.
/// <para>Compositing happens here in C# with ImageSharp rather than in a ComfyUI graph. Swarm already depends on
/// ImageSharp.Drawing and already composites this way for grid images, and doing it locally means a failed panel
/// does not cost the whole sheet.</para></summary>
public static class SheetComposite
{
    /// <summary>Font collection for panel labels, loaded once.</summary>
    public static FontCollection MainFontCollection;

    /// <summary>Cache of label fonts by size multiplier.</summary>
    public static ConcurrentDictionary<float, Font> Fonts = new();

    /// <summary>Gets the label font at a given size multiplier. Mirrors the Grid Generator's font handling so both
    /// features draw labels identically.</summary>
    public static Font GetFont(float sizeMult)
    {
        if (MainFontCollection is null)
        {
            MainFontCollection = new();
            MainFontCollection.Add("src/wwwroot/fonts/unifont-12.0.01.woff2");
        }
        return Fonts.GetOrCreate(sizeMult, () => MainFontCollection.Families.First().CreateFont(16 * sizeMult, FontStyle.Bold));
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
        int cellWidth = live.Max(p => p.ToIS.Width);
        int cellHeight = live.Max(p => p.ToIS.Height);
        float sizeMult = cellWidth > 800 || cellHeight > 800 ? 2 : 1;
        Font font = GetFont(sizeMult);
        int labelHeight = 0;
        if (labels is not null)
        {
            FontRectangle measured = TextMeasurer.MeasureSize("ABCdefg", new TextOptions(font));
            labelHeight = (int)Math.Ceiling(measured.Height * 1.6);
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
        ISImageRGBA sheet = new(totalWidth, totalHeight);
        sheet.Mutate(m =>
        {
            m.BackgroundColor(Color.White);
            Brush brush = new SolidBrush(Color.Black);
            for (int i = 0; i < live.Count && i < layout.Cells.Length; i++)
            {
                Cell cell = layout.Cells[i];
                int boxX = offsetX + cell.Col * cellWidth;
                int boxY = offsetY + cell.Row * (cellHeight + labelHeight);
                int boxW = cell.ColSpan * cellWidth;
                int boxH = cell.RowSpan * (cellHeight + labelHeight) - labelHeight;
                ISImage source = live[i].ToIS;
                // Fit rather than fill: a stretched turnaround panel is worse than a letterboxed one, because the
                // whole point of the sheet is that proportions match across views.
                double scale = Math.Min(boxW / (double)source.Width, boxH / (double)source.Height);
                int drawW = Math.Max(1, (int)Math.Round(source.Width * scale));
                int drawH = Math.Max(1, (int)Math.Round(source.Height * scale));
                using ISImageRGBA scaled = source.CloneAs<SixLabors.ImageSharp.PixelFormats.Rgba32>();
                scaled.Mutate(c => c.Resize(drawW, drawH));
                m.DrawImage(scaled, new Point(boxX + (boxW - drawW) / 2, boxY + (boxH - drawH) / 2), 1);
                if (labelHeight > 0 && i < liveLabels.Count && !string.IsNullOrWhiteSpace(liveLabels[i]))
                {
                    RichTextOptions text = new(font)
                    {
                        WrappingLength = boxW,
                        HorizontalAlignment = HorizontalAlignment.Center,
                        Origin = new(boxX + boxW / 2f, boxY + boxH + labelHeight * 0.15f)
                    };
                    m.DrawText(text, liveLabels[i], brush);
                }
            }
        });
        return new Image(sheet);
    }
}
