from PIL import Image, ImageOps, ImageSequence
import numpy as np
import torch, base64, io
from comfy_api.input_impl import VideoFromFile
try:
    from comfy_extras.nodes_audio import load as raw_audio_load
except:
    print("Error: Nodes_Audio failed to import, Swarm will not be able to load audio files.")

# Multi-image containers that are still photos, not animations: every image after the primary is an
# auxiliary (HDR gain map, depth map, thumbnail) and must not become a prompt-image frame. JPEG+MPF from
# an iPhone opens as 'MPO'. Add to this rather than special-casing in the loop.
STILL_CONTAINER_FORMATS = ('MPO',)

def b64_to_img_and_mask(image_base64):
    """Decodes a base64 image into an (IMAGE, MASK) batch, one entry per frame.

    Mirrors ComfyUI's own LoadImage (nodes.py) frame by frame rather than stacking every frame at once.
    The old shape of this was `np.array([frame for frame in frames])`, which raises "setting an array
    element with a sequence ... inhomogeneous shape" the moment an animation carries frames of more than one
    size - and animated WebP and GIF both permit that, since a frame may be a partial region of the canvas.
    A phone pasting a short animation into the prompt box was enough to hit it. As in LoadImage, the first
    frame fixes the canvas and any frame that disagrees is skipped, so the batch is always rectangular.

    The case that actually surfaced was not an animation at all. An iPhone photo shared as JPEG carries its
    HDR gain map (and sometimes a depth map or thumbnail) as extra embedded images in an MPO container, and
    PIL exposes those as frames: format=MPO, n_frames=3, three different sizes. So one ordinary phone photo
    produced the (3,) crash. MPO is a still-photo container, and only its primary image means anything as a
    prompt image - the others are metadata that happens to be pixels - so an MPO yields exactly one frame
    even when an extra image is full resolution and would otherwise pass the size check.

    Two smaller corrections ride along, both also matching LoadImage: EXIF orientation is applied to every
    frame instead of only to still images, and the mask is per frame instead of one mask (from frame 0)
    for an N-frame batch."""
    imageData = base64.b64decode(image_base64)
    img = Image.open(io.BytesIO(imageData))
    output_images = []
    output_masks = []
    w, h = None, None
    for i in ImageSequence.Iterator(img):
        if len(output_images) > 0 and img.format in STILL_CONTAINER_FORMATS:
            break
        i = ImageOps.exif_transpose(i)
        image = i.convert("RGB")
        if len(output_images) == 0:
            w, h = image.size
        if image.size[0] != w or image.size[1] != h:
            continue
        image = np.array(image).astype(np.float32) / 255.0
        image = torch.from_numpy(image)[None,]
        if 'A' in i.getbands():
            mask = np.array(i.getchannel('A')).astype(np.float32) / 255.0
            mask = 1. - torch.from_numpy(mask)
        else:
            mask = torch.zeros((64,64), dtype=torch.float32, device="cpu")
        output_images.append(image)
        output_masks.append(mask.unsqueeze(0))
    return (torch.cat(output_images, dim=0), torch.cat(output_masks, dim=0))

class SwarmLoadImageB64:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "image_base64": ("STRING", {"multiline": True})
            }
        }

    CATEGORY = "SwarmUI/images"
    RETURN_TYPES = ("IMAGE", "MASK")
    FUNCTION = "load_image_b64"
    DESCRIPTION = "Loads an image from a base64 string. Works like a regular LoadImage node, but with input format designed to be easier to use through automated calls, including SwarmUI with custom workflows."

    def load_image_b64(self, image_base64):
        return b64_to_img_and_mask(image_base64)

class SwarmLoadVideoB64:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "video_base64": ("STRING", {"multiline": True})
            }
        }

    CATEGORY = "SwarmUI/images"
    RETURN_TYPES = ("VIDEO",)
    FUNCTION = "load_video_b64"
    DESCRIPTION = "Loads a video from a base64 string. Works like a regular LoadVideo node, but with input format designed to be easier to use through automated calls, including SwarmUI with custom workflows."

    def load_video_b64(self, video_base64):
        video_data = base64.b64decode(video_base64)
        video_bytes = io.BytesIO(video_data)
        return (VideoFromFile(video_bytes), )

class SwarmLoadAudioB64:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "audio_base64": ("STRING", {"multiline": True})
            }
        }
    CATEGORY = "SwarmUI/images"
    RETURN_TYPES = ("AUDIO",)
    FUNCTION = "load_audio_b64"
    DESCRIPTION = "Loads an audio from a base64 string. Works like a regular LoadAudio node, but with input format designed to be easier to use through automated calls, including SwarmUI with custom workflows."

    def load_audio_b64(self, audio_base64):
        audio_data = base64.b64decode(audio_base64)
        audio_bytes = io.BytesIO(audio_data)
        waveform, sample_rate = raw_audio_load(audio_bytes)
        audio = {"waveform": waveform.unsqueeze(0), "sample_rate": sample_rate}
        return (audio, )

NODE_CLASS_MAPPINGS = {
    "SwarmLoadImageB64": SwarmLoadImageB64,
    "SwarmLoadVideoB64": SwarmLoadVideoB64,
    "SwarmLoadAudioB64": SwarmLoadAudioB64,
}
