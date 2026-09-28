defmodule ExecutionEngine.Application do
  use Application

  @port String.to_integer(System.get_env("PORT", "4001"))

  def start(_type, _args) do
    children = [
      ExecutionEngine.TradeQueue,
      {Plug.Cowboy, scheme: :http, plug: ExecutionEngine.Router, options: [port: @port]}
    ]

    opts = [strategy: :one_for_one, name: ExecutionEngine.Supervisor]
    IO.puts("[ExecutionEngine] Starting on port #{@port}")
    Supervisor.start_link(children, opts)
  end
end
