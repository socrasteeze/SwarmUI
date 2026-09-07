# User Settings in SwarmUI

(TODO: general info about settings)

## Path Format

`User -> OutpathBuilder -> Format` accepts the following format keys:

- `[year]`: 4-digit year, eg 2023
- `[month]`: 2-digit month, eg 07
- `[month_name]`: full month name, eg July
- `[day]`: 2-digit day, eg 29
- `[day_name]`: full day name, eg Saturday
- `[hour]`: 2-digit hour, eg 12
- `[minute]`: 2-digit minute, eg 04
- `[second]`: 2-digit second, eg 30
- `[millisecond]`: 3-digit millisecond, eg 057
- `[request_time_inc]`: an arbitrary incrementing number of requests to force orderly names, pair as `[hour][minute][request_time_inc]` to get unique linear id prefixes.
- `[prompt]`: the prompt (often cut off by `MaxLenPerPart`)
- `[negative_prompt]`: the negative prompt (often cut off by `MaxLenPerPart`)
- `[prompthash]`: a short (8 character) SHA256 hash prefix of the prompt
- `[negativeprompthash]`: a short (8 character) SHA256 hash prefix of the negative prompt
- `[seed]`: the seed number parameter
- `[cfg_scale]`: the CFG Scale parameter
- `[width]`: the Width parameter
- `[height]`: the Height parameter
- `[steps]`: the Steps number parameter
- `[model]`: the filename of the model
- `[model_title]`: the metadata title of the model
- `[user_name]`: the name of the user
- `[batch_id]`: the index # of this image within the batch
- `[some parameter name here]`: the value of the parameter named. Must have exact parameter name. For example `[refinermodel]` will get you the name of the refiner model.

If names overlap, a numeric index will be appended to the end, eg if `123-a cat.jpg` is your output but it already exists, `123-a cat-1.jpg` will be used.

## Filename Prefix

The `Filename Prefix` parameter (under the `Output Naming` group) adds short text to the start of the filename, for tagging a working session. With a prefix of `OC01` and a format of `[model]/[year][month]`, files save as `[model]/OC01[year][month]`.

It is inserted automatically, so it applies whatever format is in effect - including when a preset overrides the outpath format. It only affects the filename, never the folders.

To place it somewhere other than the start, put a `[filenameprefix]` tag in your format instead; the automatic insertion is skipped whenever the format contains that tag.

Slashes and square brackets are stripped from the prefix, leading/trailing dots and `..` runs are removed (interior dots such as `v1.0` are kept), and it is capped at 40 characters. A prefix that reduces to nothing is treated as unset. Interior dots survive to disk for every role, so a prefix of `v1.0` saves as `v1.0`.

The number of folders a format may create is capped by the role's `MaxOutPathDepth` setting (default 5). A format nesting deeper than that has its extra folders joined into one, rather than being rejected — the filename itself is never altered.

## Hiding Folders From Image History

`User -> HiddenHistoryFolders` takes a comma separated list of folder names to leave out of the Image History browser, eg `_comfy0,VNCCS`. Use it for scratch or tool-owned folders that clutter the tree.

Only folders sitting directly in your output directory are matched, and matching is case-insensitive. A hidden folder and everything under it disappears from the listing on both the Generate tab and `/simple`. Nothing is deleted or moved - clear the setting and the folders come back.

This also covers folders a backend registers into the history, such as the ComfyUI scratch folders (`_comfy0` and friends), which are grafted into the listing rather than found by the directory walk.

## Folder Order In Image History

The `Starred` folder is pinned to the top of the Image History folder list on both the Generate tab and `/simple`; everything else stays A-Z. Its subfolders stay grouped underneath it.

