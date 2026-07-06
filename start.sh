#!/bin/bash

# AI Analytics Assistant — Quick Start

echo ""
echo "🤖 AI Business Analytics Assistant"
echo "===================================="
echo ""

# Check if .env exists for backend
if [ ! -f "backend/.env" ]; then
  echo "⚠️  backend/.env not found. Copying from .env.example..."
  cp backend/.env.example backend/.env
  echo "✅ Created backend/.env — please fill in your credentials before running again."
  echo ""
  echo "   Required:"
  echo "   ANTHROPIC_API_KEY=sk-ant-..."
  echo "   DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD"
  echo ""
  exit 1
fi

# Install dependencies
echo "📦 Installing backend dependencies..."
cd backend && npm install --silent
cd ..

echo "📦 Installing frontend dependencies..."
cd frontend && npm install --silent
cd ..

echo ""
echo "🚀 Starting services..."
echo ""

# Start backend in background
cd backend && npm run dev &
BACKEND_PID=$!
cd ..

sleep 2

# Start frontend
cd frontend && npm run dev &
FRONTEND_PID=$!
cd ..

echo "✅ Backend:  http://localhost:3001"
echo "✅ Frontend: http://localhost:3000"
echo ""
echo "Press Ctrl+C to stop both services."

# Wait and cleanup on Ctrl+C
trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; echo 'Stopped.'; exit 0" INT TERM
wait
