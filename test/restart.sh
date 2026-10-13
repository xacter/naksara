#!/bin/bash
# Yerel test sunucusunu temiz veritabanıyla yeniden başlatır
SP=/tmp/claude-0/-home-claude/a26849bd-e6df-558f-a798-95d5b7aa8108/scratchpad
[ -f $SP/server.pid ] && kill $(cat $SP/server.pid) 2>/dev/null; sleep 0.4
[ "$1" != "keep" ] && rm -f $SP/test.db
cd /home/claude/naksara
nohup node --no-warnings test/server.mjs 8787 $SP/test.db "$(cat $SP/pw_hash)" > $SP/server.log 2>&1 &
echo $! > $SP/server.pid
sleep 1
