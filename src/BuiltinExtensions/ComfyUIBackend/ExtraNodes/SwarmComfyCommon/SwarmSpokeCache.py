"""Resolve spoke cache entries only while they match the shared model of record."""

import logging
import os

import folder_paths


def is_under(path, root):
    """Compare normalized paths with a directory boundary."""
    try:
        return os.path.commonpath([os.path.abspath(path), root]) == root
    except ValueError:
        return False


def install(cache_root):
    """Wrap Comfy's resolver only for a self-start spoke with an explicit cache."""
    root = os.path.normcase(os.path.abspath(cache_root))
    original = folder_paths.get_full_path

    def resolve(folder_name, filename):
        """Prefer local bytes only after a cheap size and modification-time check."""
        resolved = original(folder_name, filename)
        if resolved is None or not is_under(os.path.normcase(resolved), root):
            return resolved
        mapped_name = folder_paths.map_legacy(folder_name)
        directories = folder_paths.folder_names_and_paths.get(mapped_name, ([], set()))[0]
        relative = os.path.relpath(os.path.join("/", filename), "/")
        # Preserve Comfy's root ordering: the first existing non-cache model is authoritative.
        for directory in directories:
            source = os.path.join(directory, relative)
            if is_under(os.path.normcase(source), root):
                continue
            try:
                source_stat = os.stat(source)
            except FileNotFoundError:
                continue
            except OSError:
                # An inaccessible share cannot prove the cached bytes are current.
                return None
            if not os.path.isfile(source):
                continue
            try:
                cached_stat = os.stat(resolved)
                if cached_stat.st_size == source_stat.st_size and cached_stat.st_mtime_ns == source_stat.st_mtime_ns:
                    return resolved
            except OSError:
                pass
            return source
        return None

    folder_paths.get_full_path = resolve
    logging.info("Swarm spoke model cache freshness checks enabled")


cache_root = os.environ.get("SWARM_SPOKE_CACHE_ROOT")
if cache_root:
    install(cache_root)
