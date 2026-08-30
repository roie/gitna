//go:build !darwin

package folder

func platformPathIdentity(string) (string, bool) {
	return "", false
}
