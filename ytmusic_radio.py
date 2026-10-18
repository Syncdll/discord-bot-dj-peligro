#!/usr/bin/env python3
import json
import sys

from ytmusicapi import YTMusic


def print_json(payload):
    print(json.dumps(payload, ensure_ascii=False))


def get_first_artist(track):
    artists = track.get("artists") or []

    if not artists:
        return ""

    first_artist = artists[0]

    if isinstance(first_artist, dict):
        return first_artist.get("name") or ""

    return str(first_artist or "")


def build_recommendation(track):
    video_id = track.get("videoId")
    raw_title = track.get("title") or ""

    if not video_id or not raw_title:
        return None

    artist = get_first_artist(track)
    display_title = f"{artist} - {raw_title}" if artist else raw_title

    return {
        "title": display_title,
        "artist": artist,
        "videoId": video_id,
        "url": f"https://www.youtube.com/watch?v={video_id}",
    }


def main():
    if len(sys.argv) < 2:
        print_json({
            "ok": False,
            "error": "Missing videoId argument",
        })
        return 1

    video_id = sys.argv[1].strip()

    if not video_id:
        print_json({
            "ok": False,
            "error": "Empty videoId argument",
        })
        return 1

    try:
        ytmusic = YTMusic()
        playlist = ytmusic.get_watch_playlist(
            videoId=video_id,
            radio=True,
            limit=25,
        )

        recommendations = []

        for track in playlist.get("tracks", []):
            track_video_id = track.get("videoId")

            if not track_video_id or track_video_id == video_id:
                continue

            recommendation = build_recommendation(track)

            if recommendation:
                recommendations.append(recommendation)

        print_json({
            "ok": True,
            "videoId": video_id,
            "recommendations": recommendations,
        })
        return 0

    except Exception as error:
        print_json({
            "ok": False,
            "error": str(error),
        })
        return 1


if __name__ == "__main__":
    sys.exit(main())
