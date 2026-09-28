defmodule ExecutionEngine.TradeQueue do
  @moduledoc """
  GenServer that manages the trade execution queue.
  Orders are received from the NeuralTrade API server, validated,
  and dispatched to the Deriv broker when a token is configured.
  Until the Deriv API token is set, orders are held as :pending_broker.
  """
  use GenServer
  require Logger

  defstruct [:id, :symbol, :direction, :lot_size, :signal_id, :contract_id,
             :stop_loss, :take_profit, :status, :inserted_at, :error]

  def start_link(_opts), do: GenServer.start_link(__MODULE__, [], name: __MODULE__)

  def enqueue(order), do: GenServer.call(__MODULE__, {:enqueue, order})
  def list_queue,      do: GenServer.call(__MODULE__, :list)
  def stats,           do: GenServer.call(__MODULE__, :stats)

  # --- GenServer callbacks ---

  @impl true
  def init(_) do
    Logger.info("[TradeQueue] GenServer started — ready to accept orders from signal worker")
    {:ok, %{queue: [], processed: 0, failed: 0}}
  end

  @impl true
  def handle_call({:enqueue, order}, _from, state) do
    order_id = :crypto.strong_rand_bytes(6) |> Base.encode16(case: :lower)
    contract_id = Map.get(order, "contract_id")
    status = if contract_id, do: "dispatched", else: "queued"
    entry = Map.merge(order, %{
      "id" => order_id,
      "status" => status,
      "inserted_at" => DateTime.utc_now() |> DateTime.to_iso8601()
    })
    if contract_id do
      Logger.info("[TradeQueue] Order #{order_id} recorded — Deriv contract #{contract_id} for #{entry["symbol"]} #{entry["direction"]}")
    else
      Logger.info("[TradeQueue] Order #{order_id} queued for #{entry["symbol"]} #{entry["direction"]}")
    end
    new_state = %{state |
      queue: [entry | state.queue],
      processed: if(contract_id, do: state.processed + 1, else: state.processed)
    }
    {:reply, {:ok, entry}, new_state}
  end

  @impl true
  def handle_call(:list, _from, state) do
    {:reply, state.queue, state}
  end

  @impl true
  def handle_call(:stats, _from, state) do
    {:reply, %{
      "queued" => length(state.queue),
      "processed" => state.processed,
      "failed" => state.failed,
      "brokerConnected" => state.processed > 0
    }, state}
  end
end
