package main

import (
	"fmt"

	"gopkg.in/yaml.v2"
)

func main() {
	var out map[string]interface{}
	if err := yaml.Unmarshal([]byte("a: 1"), &out); err != nil {
		fmt.Println(err)
	}
	fmt.Println(out)
}
