# Privacy Policy

**DJ Peligro**
A SYNC.dll project.

Last updated: October 18, 2026.

## Overview

DJ Peligro is a Discord music bot that plays YouTube audio in voice channels and provides playback controls, queues, and automatic music recommendations.

The bot processes information necessary to receive playback requests and operate music sessions.

## Data stored

### Temporary session data

DJ Peligro maintains references to certain Discord messages in memory while a session is active.

These references contain channel IDs and message IDs.

During session cleanup, the bot attempts to delete associated command and session messages and clears their references from memory.

Message deletion may depend on Discord permissions and API availability.

### Persistent storage

The current application does not implement a dedicated database for storing Discord user profiles or playback history.

Temporary runtime information and operational logs are handled separately.

## Data processed during operation

DJ Peligro may process:

- Discord server and channel IDs;
- voice channel information;
- message IDs associated with playback commands;
- playback commands and YouTube URLs;
- song titles, playback queues, and session status;
- technical information required to operate Discord voice connections.

This information is used to manage playback, display controls, and maintain active music sessions.

## Operational logs

DJ Peligro generates operational logs for troubleshooting and service maintenance.

These logs may include:

- playback commands and their message content;
- requested YouTube URLs;
- song titles and playback status;
- technical errors and connection information.

Logs may persist on the hosting system according to its logging and retention configuration.

Session cleanup does not automatically delete previously recorded system logs.

## Data not collected

DJ Peligro is not designed to collect:

- Discord account passwords;
- Discord user authentication tokens;
- voice recordings or conversation transcripts;
- payment information.

The bot's own authentication token is kept outside the public source code.

## Data retention and deletion

Temporary session references are cleared during session cleanup.

Operational logs are retained according to the configuration of the hosting system and may outlast individual music sessions.

For questions about data handling or deletion, contact the project maintainer through the public GitHub repository.

Do not publish personal information or credentials in public issues.

## Third-party services

DJ Peligro relies on Discord, YouTube, and YouTube Music-related services to provide its functionality.

Playback requests and music searches may involve communication with these external services.

Their respective terms and privacy policies apply.

## Sale of data

DJ Peligro does not sell user or server data.

## Security

Reasonable technical measures are used to limit access to operational data and protect service credentials.

No system can guarantee absolute security.

## Changes to this policy

This Privacy Policy may be updated when the bot's functionality or data handling changes.

The current version will remain available in the public project repository.

## Contact

Questions about this Privacy Policy can be submitted through the GitHub repository for DJ Peligro.
