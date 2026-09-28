defmodule ExecutionEngineTest do
  use ExUnit.Case
  doctest ExecutionEngine

  test "greets the world" do
    assert ExecutionEngine.hello() == :world
  end
end
