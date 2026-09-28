defmodule ExecutionEngine.Router do
  @moduledoc "HTTP API for the Elixir trade execution engine."
  use Plug.Router

  plug Plug.Logger
  plug :match
  plug Plug.Parsers, parsers: [:json], json_decoder: Jason
  plug :dispatch

  get "/health" do
    stats = ExecutionEngine.TradeQueue.stats()
    send_json(conn, 200, Map.merge(%{"status" => "ok", "engine" => "elixir"}, stats))
  end

  post "/execute" do
    body = conn.body_params
    required = ["symbol", "direction", "lot_size", "signal_id"]
    missing = Enum.filter(required, &(!Map.has_key?(body, &1)))

    if missing != [] do
      send_json(conn, 400, %{"error" => "Missing fields: #{Enum.join(missing, ", ")}"})
    else
      case ExecutionEngine.TradeQueue.enqueue(body) do
        {:ok, order} -> send_json(conn, 201, order)
      end
    end
  end

  get "/queue" do
    orders = ExecutionEngine.TradeQueue.list_queue()
    send_json(conn, 200, %{"orders" => orders, "count" => length(orders)})
  end

  match _ do
    send_json(conn, 404, %{"error" => "not found"})
  end

  defp send_json(conn, status, body) do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(status, Jason.encode!(body))
  end
end
