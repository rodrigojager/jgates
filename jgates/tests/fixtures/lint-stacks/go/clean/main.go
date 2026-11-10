package main

import (
	"fmt"
	"os"
)

func main() {
	if err := os.Remove("scratch.tmp"); err != nil {
		fmt.Println(err)
	}
}
