#!/bin/bash

# Get the directory where this script lives
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

echo "================================================"
echo "  The Watch Box Co. - COGS & Inventory Manager"
echo "================================================"
echo ""
echo "Starting app... please wait..."
echo ""

# Start backend in a new Terminal tab
osascript -e "tell application \"Terminal\"
    do script \"cd '$DIR/backend' && npm run dev\"
end tell"

# Wait for backend to start
sleep 3

# Start frontend in another Terminal tab
osascript -e "tell application \"Terminal\"
    do script \"cd '$DIR/frontend' && npm start\"
end tell"

echo "Both servers starting..."
echo "Your browser will open automatically in a few seconds."
echo ""
echo "To stop the app, close the two Terminal windows."
