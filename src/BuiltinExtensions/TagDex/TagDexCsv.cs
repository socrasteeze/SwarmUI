using System.IO;

namespace SwarmUI.Builtin_TagDexExtension;

/// <summary>Minimal RFC-4180 CSV reader for the tag datasets.
/// <para>This deliberately does not use <see cref="SwarmUI.Utils.Utilities.SplitStandardCsv"/>. When this was written
/// that helper had three behaviors that corrupted this specific data, all present in the live Laxhar/noob-wiki files:</para>
/// <list type="number">
/// <item>Its backslash branch advanced the index without appending anything, so <c>ursula_(no\name)</c> parsed as
/// <c>ursula_(noame)</c>. 2 rows in danbooru_character.csv. <b>Fixed in core 2026-08-29.</b></item>
/// <item>It only entered quoted mode after a comma immediately followed by a quote, so a quoted FIRST field was not
/// recognized. 60 rows in danbooru_character.csv. <b>Fixed in core 2026-08-29.</b></item>
/// <item>It allocates a List, a StringBuilder and N substrings per row, to retain 4 strings - roughly 5 million
/// throwaway allocations across the four datasets. Still true.</item>
/// </list>
/// <para>The allocation cost alone justifies keeping this reader; it also means TagDex parsing never depends on a
/// core file's behavior surviving an upstream merge.</para></summary>
public static class TagDexCsv
{
    /// <summary>Splits one CSV line into fields, reusing the caller's buffer.
    /// <para>Returns the number of fields written. Fields beyond <paramref name="fields"/>.Length are parsed and
    /// discarded rather than throwing, so an upstream schema that gains a trailing column still loads.</para>
    /// <para>Quoting is RFC-4180: a field is quoted when its first non-consumed character is a quote, an inner
    /// <c>""</c> is a literal quote, and backslashes are ordinary characters (booru tags legitimately contain them).</para></summary>
    public static int SplitLine(string line, string[] fields, StringBuilder buffer)
    {
        int count = 0;
        int i = 0;
        while (i <= line.Length)
        {
            buffer.Clear();
            if (i < line.Length && line[i] == '"')
            {
                i++;
                while (i < line.Length)
                {
                    char c = line[i];
                    if (c == '"')
                    {
                        if (i + 1 < line.Length && line[i + 1] == '"')
                        {
                            buffer.Append('"');
                            i += 2;
                            continue;
                        }
                        i++;
                        break;
                    }
                    buffer.Append(c);
                    i++;
                }
                while (i < line.Length && line[i] != ',')
                {
                    i++;
                }
            }
            else
            {
                while (i < line.Length && line[i] != ',')
                {
                    buffer.Append(line[i]);
                    i++;
                }
            }
            if (count < fields.Length)
            {
                fields[count] = buffer.ToString();
            }
            count++;
            if (i >= line.Length)
            {
                break;
            }
            i++;
            if (i == line.Length)
            {
                if (count < fields.Length)
                {
                    fields[count] = "";
                }
                count++;
                break;
            }
        }
        return count;
    }

    /// <summary>Reads the header line of a CSV and returns a map of lowercased column name to column index.
    /// <para>Column-name driven rather than positional, because the four datasets ship three different schemas:
    /// danbooru_character has core_tags, e621_character does not, and the artist files have neither core_tags nor
    /// copyright nor solo_count. Absent columns simply resolve to -1 at the call site.</para></summary>
    public static Dictionary<string, int> ReadHeader(StreamReader reader, StringBuilder buffer)
    {
        string line = reader.ReadLine();
        if (line is null)
        {
            return null;
        }
        if (line.Length > 0 && line[0] == '﻿')
        {
            line = line[1..];
        }
        string[] fields = new string[32];
        int count = SplitLine(line, fields, buffer);
        Dictionary<string, int> map = [];
        for (int i = 0; i < count && i < fields.Length; i++)
        {
            string name = fields[i].Trim().ToLowerInvariant();
            if (name.Length > 0 && !map.ContainsKey(name))
            {
                map[name] = i;
            }
        }
        return map;
    }
}
